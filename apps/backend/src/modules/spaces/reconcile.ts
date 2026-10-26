import { and, eq, lt } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Db } from '../../infra/db.ts'
import { failureStreak } from '../../infra/failing.ts'
import type { ListedMember, SpaceDirectory } from '../../infra/ldap-rest.ts'
import { organizations } from '../organizations/schema.ts'
import { ensureDrive } from './drives.ts'
import {
  createSpace,
  deleteSpace,
  removeSpaceMembers,
  renameSpace,
  unlinkGroups,
  upsertGroups,
  upsertMembers
} from './events.ts'
import {
  spaceGroups,
  spaceMembers,
  spaceReconciliations,
  spaces
} from './schema.ts'

type Reader = Pick<SpaceDirectory, 'list' | 'members' | 'groups' | 'exists'>

const CHECK_EVERY_MS = 60 * 60 * 1000
const ACTOR = 'reconciliation'

const readable = (
  m: ListedMember
): m is ListedMember & { uuid: string; email: string } =>
  m.uuid !== undefined && m.email !== undefined

// Repairs what lost events left behind. Each write is stamped with the time
// taken before its read from ldap-rest, so an event applied since then wins.
export async function reconcileOrganization(
  db: Db,
  directory: Reader,
  log: Logger,
  organizationId: string
) {
  const listedAt = new Date()
  const listed = await directory.list(organizationId)
  // Its deletion event cleans up; deleting every space on a 404 is too blunt.
  if (!listed) {
    log.info({ organizationId }, 'ldap-rest does not know the organization')
    return
  }
  let failed = 0
  for (const space of listed) {
    try {
      await reconcileSpace(db, directory, log, organizationId, listedAt, space)
    } catch (error) {
      failed++
      log.warn(
        { err: error, organizationId, spaceId: space.id },
        'reconciling a space failed'
      )
    }
  }

  const kept = new Set(listed.map(s => s.id))
  const copied = await db
    .select({ id: spaces.spaceId })
    .from(spaces)
    .where(eq(spaces.organizationId, organizationId))
  for (const { id } of copied.filter(s => !kept.has(s.id))) {
    // A paged listing skips a space when one before it goes away mid-read.
    if (await directory.exists(organizationId, id)) continue
    await db.transaction(tx => deleteSpace(tx, id, listedAt, ACTOR))
  }
  if (failed > 0)
    throw new Error(`${String(failed)} spaces failed to reconcile`)
}

async function reconcileSpace(
  db: Db,
  directory: Reader,
  log: Logger,
  organizationId: string,
  listedAt: Date,
  { id, name }: { id: string; name: string }
) {
  const at = new Date()
  const read = await Promise.all([
    directory.members(organizationId, id),
    directory.groups(organizationId, id)
  ]).catch(async (error: unknown) => {
    // Deleted since the listing: its deletion event removes it.
    if (!(await directory.exists(organizationId, id))) return undefined
    throw error
  })
  if (!read) return
  const [members, groups] = read
  const people = members.filter(readable)
  await db.transaction(async tx => {
    const [space] = await tx
      .select({ name: spaces.name })
      .from(spaces)
      .where(eq(spaces.spaceId, id))
    if (!space) {
      await createSpace(
        tx,
        log,
        {
          id,
          organizationId,
          name,
          createdBy: null,
          members: people,
          groups
        },
        listedAt
      )
      return
    }
    if (space.name !== name) await renameSpace(tx, id, name, listedAt)

    const copied = await tx
      .select()
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, id))
    const byUser = new Map(copied.map(m => [m.userId, m]))
    await upsertMembers(
      tx,
      log,
      id,
      at,
      people.filter(p => {
        const row = byUser.get(p.uuid)
        return (
          row?.role !== p.role ||
          row.username !== p.username ||
          row.email !== p.email ||
          row.displayName !== p.displayName
        )
      })
    )
    const listedIds = new Set(people.map(p => p.uuid))
    const unreadable = new Set(
      members.filter(m => !readable(m)).map(m => m.username)
    )
    const absent = copied.filter(
      m => !listedIds.has(m.userId) && !unreadable.has(m.username)
    )
    // A paged listing skips a member when one before it leaves mid-read.
    const reread =
      absent.length === 0
        ? new Set<string>()
        : new Set(
            (await directory.members(organizationId, id)).map(m => m.username)
          )
    const gone = absent.filter(m => !reread.has(m.username))
    if (gone.length > 0) {
      await removeSpaceMembers(
        tx,
        log,
        id,
        at,
        gone.map(m => ({ uuid: m.userId }))
      )
    }

    const linked = await tx
      .select()
      .from(spaceGroups)
      .where(eq(spaceGroups.spaceId, id))
    const byGroup = new Map(linked.map(g => [g.groupId, g]))
    const changed = groups.filter(g => {
      const row = byGroup.get(g.id)
      return row?.role !== g.role || row.name !== g.name
    })
    if (changed.length > 0) await upsertGroups(tx, id, at, changed)
    const listedGroups = new Set(groups.map(g => g.id))
    const unlinked = linked
      .filter(g => !listedGroups.has(g.groupId))
      .map(g => g.groupId)
    if (unlinked.length > 0) await unlinkGroups(tx, id, at, unlinked)
    // Also when nothing changed: it repairs a drive whose command was lost.
    ensureDrive(tx, id)
  })
}

function lastNight(now: Date) {
  const night = new Date(now)
  night.setUTCHours(2, 0, 0, 0)
  if (night > now) night.setUTCDate(night.getUTCDate() - 1)
  return night
}

// One replica wins each organization's claim; an organization never
// reconciled is due at once.
async function claim(db: Db, organizationId: string, now: Date) {
  const claimed = await db
    .insert(spaceReconciliations)
    .values({ organizationId, ranAt: now })
    .onConflictDoUpdate({
      target: spaceReconciliations.organizationId,
      set: { ranAt: now },
      setWhere: lt(spaceReconciliations.ranAt, lastNight(now))
    })
    .returning({ organizationId: spaceReconciliations.organizationId })
  return claimed.length > 0
}

export async function reconcileDue(
  db: Db,
  directory: Reader,
  log: Logger,
  now = new Date(),
  stopped = () => false
): Promise<{ attempted: number; failures: unknown[] }> {
  let attempted = 0
  const failures: unknown[] = []
  const known = await db
    .select({ id: organizations.organizationId })
    .from(organizations)
    .union(db.selectDistinct({ id: spaces.organizationId }).from(spaces))
  for (const { id } of known) {
    if (stopped()) break
    if (!(await claim(db, id, now))) continue
    attempted++
    try {
      await reconcileOrganization(db, directory, log, id)
    } catch (error) {
      failures.push(error)
      log.warn({ err: error, organizationId: id }, 'reconciliation failed')
      // So the next pass tries again.
      await db
        .delete(spaceReconciliations)
        .where(
          and(
            eq(spaceReconciliations.organizationId, id),
            eq(spaceReconciliations.ranAt, now)
          )
        )
    }
  }
  return { attempted, failures }
}

export function scheduleReconciliation(
  db: Db,
  directory: Reader,
  logger: Logger
): () => Promise<void> {
  let stopped = false
  let running: Promise<void> | undefined
  const passes = failureStreak(logger, 'reconciliation failed')
  const reconcile = () => {
    running ??= reconcileDue(db, directory, logger, new Date(), () => stopped)
      .then(
        ({ attempted, failures }) => {
          // A pass with nothing due says nothing about the last failure.
          if (attempted === 0) return
          if (failures.length === 0) passes.succeeded()
          else {
            passes.failed({
              err: failures.at(-1),
              organizations: failures.length
            })
          }
        },
        (error: unknown) => {
          passes.failed({ err: error })
        }
      )
      .finally(() => {
        running = undefined
      })
  }
  reconcile()
  const timer = setInterval(reconcile, CHECK_EVERY_MS)
  return async () => {
    stopped = true
    clearInterval(timer)
    await running
  }
}
