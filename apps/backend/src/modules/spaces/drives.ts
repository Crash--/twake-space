import { eq, isNotNull, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { afterCommit, beforeCommit, type Db, type Tx } from '../../infra/db.ts'
import { scheduleSweep } from '../../infra/sweep.ts'
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

type SpaceRole = (typeof spaceRole.enumValues)[number]
const right = (role: SpaceRole) => (role === 'viewer' ? 'read' : 'write')

// Milliseconds since the epoch, so the revision keeps increasing after the
// table is restored or rebuilt.
const now = sql`(extract(epoch from clock_timestamp()) * 1000)::bigint`
const next = sql`greatest(${driveCommands.revision} + 1, ${now})`

export type PublishCommand = (command: Record<string, unknown>) => Promise<void>

let nudge: () => void = () => undefined

interface Change {
  removed: boolean
  organizationId?: string | undefined
}

const DRIVES = Symbol('drives')

function changes(tx: Tx) {
  return beforeCommit(tx, DRIVES, () => new Map<string, Change>(), storeAll)
}

// At the end of the transaction and in space id order, so two transactions
// cannot deadlock on their drive rows or on the rows they lock before.
async function storeAll(tx: Tx, changed: Map<string, Change>) {
  const ordered = [...changed].sort(([a], [b]) => (a < b ? -1 : 1))
  for (const [spaceId, change] of ordered) await store(tx, spaceId, change)
}

// The row lock taken here holds until the commit, so the state read after it is
// at least as new as the one sent with any lower revision.
async function store(tx: Tx, spaceId: string, change: Change) {
  const [space] = change.removed
    ? []
    : await tx
        .select({ organizationId: spaces.organizationId })
        .from(spaces)
        .where(eq(spaces.spaceId, spaceId))
  const organizationId = space?.organizationId ?? change.organizationId
  if (!change.removed && !space) return
  const [counted] =
    organizationId === undefined
      ? await tx
          .update(driveCommands)
          .set({ revision: next, removed: true })
          .where(eq(driveCommands.spaceId, spaceId))
          .returning()
      : await tx
          .insert(driveCommands)
          .values({
            spaceId,
            organizationId,
            revision: now,
            removed: change.removed
          })
          .onConflictDoUpdate({
            target: driveCommands.spaceId,
            set: change.removed
              ? { revision: next, removed: true }
              : { revision: next },
            ...(!change.removed && {
              setWhere: eq(driveCommands.removed, false)
            })
          })
          .returning()
  if (!counted) return
  const [named] = change.removed
    ? []
    : await tx
        .select({ name: spaces.name })
        .from(spaces)
        .where(eq(spaces.spaceId, spaceId))
  const state = named
    ? {
        state: 'created',
        name: named.name,
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

/**
 * Stores the space's state for the sweep to send, once the transaction's other
 * changes are done.
 */
export function ensureDrive(tx: Tx, spaceId: string): void {
  const changed = changes(tx)
  if (!changed.has(spaceId)) changed.set(spaceId, { removed: false })
}

/**
 * Stores the removal of the space's drive for the sweep to send. Without an
 * organization, only a space that already sent a command has one to remove.
 */
export function removeDrive(
  tx: Tx,
  spaceId: string,
  organizationId?: string
): void {
  changes(tx).set(spaceId, { removed: true, organizationId })
}

// Stops at the first failure: the next sweep tries again. The row lock keeps
// other replicas off the command while it is published, and a change to the
// space waits for the publish to end.
export async function publishDriveCommands(
  db: Db,
  publish: PublishCommand,
  stopped = () => false
): Promise<void> {
  // A backlog must not hold up the shutdown: what is left stays stored.
  while (!stopped()) {
    const published = await db.transaction(async tx => {
      const [pending] = await tx
        .select({
          spaceId: driveCommands.spaceId,
          command: driveCommands.command
        })
        .from(driveCommands)
        .where(isNotNull(driveCommands.command))
        .limit(1)
        .for('update', { skipLocked: true })
      if (!pending?.command) return false
      await publish(pending.command)
      await tx
        .update(driveCommands)
        .set({ command: null })
        .where(eq(driveCommands.spaceId, pending.spaceId))
      return true
    })
    if (!published) return
  }
}

export function scheduleDriveCommands(
  db: Db,
  publish: PublishCommand,
  logger: Pick<Logger, 'warn'>
): () => Promise<void> {
  const sweep = scheduleSweep(
    stopped => publishDriveCommands(db, publish, stopped),
    SWEEP_EVERY_MS,
    error => {
      logger.warn({ err: error }, 'drive commands were not published')
    }
  )
  nudge = sweep.nudge
  return () => {
    nudge = () => undefined
    return sweep.stop()
  }
}
