import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { afterCommit, type Db, type Tx } from '../../infra/db.ts'
import {
  driveCommands,
  spaceGroups,
  spaceMembers,
  spaces,
  type spaceRole
} from './schema.ts'

// cozy-stack ADR 009: after each change to a space, the stack gets the space's
// full state and makes its organization drive match it.

const SWEEP_EVERY_MS = 10_000
const BATCH = 100

type SpaceRole = (typeof spaceRole.enumValues)[number]
const right = (role: SpaceRole) => (role === 'viewer' ? 'read' : 'write')

export type PublishCommand = (command: Record<string, unknown>) => Promise<void>

let nudge: () => void = () => undefined

// The row lock taken here holds until the commit, so the state read after it is
// at least as new as the one sent with any lower revision.
async function store(
  tx: Tx,
  spaceId: string,
  organizationId: string | undefined,
  removed: boolean
) {
  const next = { revision: sql`${driveCommands.revision} + 1` }
  const [counted] =
    organizationId === undefined
      ? await tx
          .update(driveCommands)
          .set(next)
          .where(eq(driveCommands.spaceId, spaceId))
          .returning()
      : await tx
          .insert(driveCommands)
          .values({ spaceId, organizationId, revision: 1 })
          .onConflictDoUpdate({ target: driveCommands.spaceId, set: next })
          .returning()
  if (!counted) return
  const [space] = removed
    ? []
    : await tx
        .select({ name: spaces.name })
        .from(spaces)
        .where(eq(spaces.spaceId, spaceId))
  const state = space
    ? {
        state: 'created',
        name: space.name,
        members: (
          await tx
            .select({ email: spaceMembers.email, role: spaceMembers.role })
            .from(spaceMembers)
            .where(eq(spaceMembers.spaceId, spaceId))
        ).map(m => ({ email: m.email, role: right(m.role) })),
        groups: (
          await tx
            .select({ id: spaceGroups.groupId, role: spaceGroups.role })
            .from(spaceGroups)
            .where(eq(spaceGroups.spaceId, spaceId))
        ).map(g => ({ id: g.id, role: right(g.role) }))
      }
    : { state: 'removed' }
  await tx
    .update(driveCommands)
    .set({
      command: {
        organizationId: counted.organizationId,
        reference: { source: 'twake-space', id: spaceId },
        revision: counted.revision,
        ...state,
        activity: true
      }
    })
    .where(eq(driveCommands.spaceId, spaceId))
  afterCommit(tx, () => {
    nudge()
  })
}

/** Sends the space's state to its drive once the transaction commits. */
export async function ensureDrive(tx: Tx, spaceId: string): Promise<void> {
  const [space] = await tx
    .select({ organizationId: spaces.organizationId })
    .from(spaces)
    .where(eq(spaces.spaceId, spaceId))
  if (space) await store(tx, spaceId, space.organizationId, false)
}

/**
 * Removes the space's drive once the transaction commits. Without an
 * organization, only a space that already sent a command has one to remove.
 */
export function removeDrive(
  tx: Tx,
  spaceId: string,
  organizationId?: string
): Promise<void> {
  return store(tx, spaceId, organizationId, true)
}

// Stops at the first failure: the next sweep tries again. Another replica may
// publish the same command too, which the stack applies once.
export async function publishDriveCommands(
  db: Db,
  publish: PublishCommand,
  stopped = () => false
): Promise<void> {
  for (;;) {
    const pending = await db
      .select()
      .from(driveCommands)
      .where(isNotNull(driveCommands.command))
      .limit(BATCH)
    for (const { spaceId, revision, command } of pending) {
      // A backlog must not hold up the shutdown: what is left stays stored.
      if (stopped()) return
      if (command) await publish(command)
      // A newer revision stored meanwhile stays to be published.
      await db
        .update(driveCommands)
        .set({ command: null })
        .where(
          and(
            eq(driveCommands.spaceId, spaceId),
            eq(driveCommands.revision, revision)
          )
        )
    }
    if (pending.length < BATCH) return
  }
}

export function scheduleDriveCommands(
  db: Db,
  publish: PublishCommand,
  logger: Pick<Logger, 'warn'>
): () => Promise<void> {
  let running: Promise<void> | undefined
  let again = false
  let stopped = false
  const flush = () => {
    if (running) {
      again = true
      return
    }
    running = publishDriveCommands(db, publish, () => stopped)
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'drive commands were not published')
      })
      .finally(() => {
        running = undefined
        if (again) {
          again = false
          flush()
        }
      })
  }
  nudge = flush
  flush()
  const timer = setInterval(flush, SWEEP_EVERY_MS)
  return async () => {
    nudge = () => undefined
    stopped = true
    clearInterval(timer)
    again = false
    await running
  }
}
