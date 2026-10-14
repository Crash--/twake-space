import { and, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { Logger as Pino } from 'pino'
import { z } from 'zod'
import type { PlatformEvent } from '../../events/envelope.ts'
import {
  deletedEmailKey,
  deletedUserKey,
  fresh
} from '../../events/freshness.ts'
import { lastChanges } from '../../events/schema.ts'
import {
  NotYetKnownError,
  parseOrDrop,
  type Handler
} from '../../events/router.ts'
import type { Tx } from '../../infra/db.ts'
import { fullName } from '../../infra/ldap-rest.ts'
import { forgetActor } from '../feed/activity.ts'
import { tell, tellSpaceMembers } from '../live/notify.ts'
import { deleteNotificationsOf } from '../notifications/recipients.ts'
import {
  dropSpaceFromTokens,
  revokeAccountTokens,
  revokeOrganizationTokens
} from '../tokens/revocation.ts'
import { ensureDrive, removeDrive } from './drives.ts'
import {
  groupNames,
  organizationMembers,
  organizationRole,
  spaceBanners,
  spaceGroups,
  spaceMarks,
  spaceMembers,
  spaceResourceKind,
  spaceResources,
  spaceRole,
  spaceSettings,
  spaces
} from './schema.ts'

type SpaceResourceKind = (typeof spaceResourceKind.enumValues)[number]

const timestamp = z.iso
  .datetime({ offset: true })
  .optional()
  .transform(t => (t === undefined ? undefined : new Date(t)))

const spaceEvent = z.looseObject({
  organizationId: z.string().min(1),
  id: z.uuid(),
  timestamp
})

// Only created and deleted change it: a rename applied before a replayed creation must
// not hold the creation back.
const spaceKey = (spaceId: string) => `space:${spaceId}`
const spaceNameKey = (spaceId: string) => `space:${spaceId}:name`
const memberKey = (spaceId: string, user: string) =>
  `space:${spaceId}:member:${user}`
const groupKey = (spaceId: string, groupId: string) =>
  `space:${spaceId}:group:${groupId}`
export const resourceKey = (spaceId: string, kind: SpaceResourceKind) =>
  `space:${spaceId}:resource:${kind}`

const role = z.enum(spaceRole.enumValues)

const member = z
  .looseObject({
    uuid: z.uuid().optional(),
    username: z.string().min(1),
    email: z.email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    role
  })
  .transform(({ firstName, lastName, ...m }) => ({
    ...m,
    displayName: fullName(firstName, lastName)
  }))

const group = z.looseObject({
  id: z.uuid(),
  name: z.string().min(1),
  role
})

const spaceCreated = spaceEvent.extend({
  name: z.string().min(1),
  members: z.array(member).default([]),
  groups: z.array(group).default([]),
  actor: z.string().optional()
})

const spaceUpdated = spaceEvent.extend({ name: z.string().min(1).optional() })

const memberChanged = spaceEvent.extend({ members: z.array(member).min(1) })

const person = z
  .looseObject({ uuid: z.uuid().optional(), email: z.email().optional() })
  .refine(p => p.uuid ?? p.email, 'needs a uuid or an email')

const memberRemoved = spaceEvent.extend({
  members: z.array(person).min(1)
})

const groupChanged = spaceEvent.extend({ groups: z.array(group).min(1) })

const groupUnlinked = spaceEvent.extend({
  groups: z.array(z.looseObject({ id: z.uuid() })).min(1)
})

interface Person {
  uuid?: string | undefined
  email?: string | undefined
  organizationId?: string
}

// Writes through ldap-rest log with the request's logger.
type Logger = Pick<Pino, 'warn'>

// ldap-rest lifecycle events carry no entryUUID, so a person without one is
// matched in the copy by email.
function withoutUuid(log: Logger, people: Person[]) {
  const emails = people.flatMap(p => (!p.uuid && p.email ? [p.email] : []))
  if (emails.length > 0) {
    log.warn(
      { withoutUuid: emails.length },
      'matching people sent without a uuid by email'
    )
  }
  return emails
}

function matching(log: Logger, people: Person[]) {
  return or(
    inArray(
      spaceMembers.userId,
      people.flatMap(p => (p.uuid ? [p.uuid] : []))
    ),
    inArray(spaceMembers.email, withoutUuid(log, people))
  )
}

async function withUserIds<T extends Person>(
  tx: Tx,
  log: Logger,
  people: T[]
): Promise<(T & { uuid: string })[]> {
  const emails = withoutUuid(log, people)
  const inSpaces =
    emails.length === 0
      ? []
      : await tx
          .selectDistinct({
            email: spaceMembers.email,
            userId: spaceMembers.userId
          })
          .from(spaceMembers)
          .where(inArray(spaceMembers.email, emails))
  // Organization admins need not be in any space.
  const inOrganizations =
    emails.length === 0
      ? []
      : await tx
          .select({
            organizationId: organizationMembers.organizationId,
            email: organizationMembers.email,
            userId: organizationMembers.userId
          })
          .from(organizationMembers)
          .where(inArray(organizationMembers.email, emails))
  const byEmail = (p: T) =>
    inSpaces.find(row => row.email === p.email)?.userId ??
    inOrganizations.find(
      row =>
        row.email === p.email &&
        (p.organizationId === undefined ||
          row.organizationId === p.organizationId)
    )?.userId
  return people.flatMap(p => {
    const uuid = p.uuid ?? byEmail(p)
    return uuid ? [{ ...p, uuid }] : []
  })
}

async function deletedUsers(
  tx: Tx,
  at: Date | undefined,
  people: { uuid: string; email: string }[]
): Promise<Set<string>> {
  if (at === undefined || people.length === 0) return new Set()
  const rows = await tx
    .select({ object: lastChanges.object })
    .from(lastChanges)
    .where(
      and(
        inArray(
          lastChanges.object,
          people.flatMap(p => [
            deletedUserKey(p.uuid),
            deletedEmailKey(p.email)
          ])
        ),
        gt(lastChanges.at, at)
      )
    )
  const deleted = new Set(rows.map(row => row.object))
  return new Set(
    people
      .filter(
        p =>
          deleted.has(deletedUserKey(p.uuid)) ||
          deleted.has(deletedEmailKey(p.email))
      )
      .map(p => p.uuid)
  )
}

export async function upsertGroups(
  tx: Tx,
  spaceId: string,
  at: Date | undefined,
  groups: z.infer<typeof group>[]
) {
  if (await deletedAfter(tx, spaceId, at)) return
  const changed = await fresh(
    tx,
    at,
    groups.map(g => groupKey(spaceId, g.id))
  )
  const renamed =
    at === undefined || groups.length === 0
      ? []
      : await tx
          .select({ groupId: groupNames.groupId, name: groupNames.name })
          .from(groupNames)
          .where(
            and(
              inArray(
                groupNames.groupId,
                groups.map(g => g.id)
              ),
              gt(groupNames.renamedAt, at)
            )
          )
  const newestName = new Map(renamed.map(r => [r.groupId, r.name]))
  const byId = new Map(
    groups
      .filter(g => changed.has(groupKey(spaceId, g.id)))
      .map(({ id, name, role }) => [
        id,
        { spaceId, groupId: id, name: newestName.get(id) ?? name, role }
      ])
  )
  if (byId.size === 0) return
  await tx
    .insert(spaceGroups)
    .values([...byId.values()])
    .onConflictDoUpdate({
      target: [spaceGroups.spaceId, spaceGroups.groupId],
      set: { name: sql`excluded.name`, role: sql`excluded.role` }
    })
  await ensureDrive(tx, spaceId)
  await tellSpaceMembers(tx, spaceId)
}

export async function upsertMembers(
  tx: Tx,
  log: Logger,
  spaceId: string,
  at: Date | undefined,
  members: z.infer<typeof member>[]
) {
  if (await deletedAfter(tx, spaceId, at)) return
  const identified = await withUserIds(tx, log, members)
  const deleted = await deletedUsers(tx, at, identified)
  const known = identified.filter(m => !deleted.has(m.uuid))
  const changed = await fresh(
    tx,
    at,
    known.map(m => memberKey(spaceId, m.uuid))
  )
  // One upsert cannot touch a row twice, so a member listed twice keeps its last entry.
  const byUser = new Map(
    known
      .filter(m => changed.has(memberKey(spaceId, m.uuid)))
      .map(({ uuid, username, email, displayName, role }) => [
        uuid,
        { spaceId, userId: uuid, username, email, displayName, role }
      ])
  )
  if (byUser.size === 0) return
  await tx
    .insert(spaceMembers)
    .values([...byUser.values()])
    .onConflictDoUpdate({
      target: [spaceMembers.spaceId, spaceMembers.userId],
      set: {
        username: sql`excluded.username`,
        email: sql`excluded.email`,
        displayName: sql`excluded.display_name`,
        role: sql`excluded.role`
      }
    })
  await ensureDrive(tx, spaceId)
  tell(tx, 'spaces', [...byUser.keys()], { spaceId })
}

export async function deletedAfter(
  tx: Tx,
  spaceId: string,
  at: Date | undefined
) {
  if (at === undefined) return false
  const [deletion] = await tx
    .select({ at: lastChanges.at })
    .from(lastChanges)
    .leftJoin(spaces, eq(spaces.spaceId, spaceId))
    .where(
      and(
        eq(lastChanges.object, spaceKey(spaceId)),
        gt(lastChanges.at, at),
        isNull(spaces.spaceId)
      )
    )
  return deletion !== undefined
}

// Each caller scopes `where` to one space or one user, so the pairs left after the
// freshness check are the rows of the remaining user ids. `absent` marks members
// not in the copy yet, so their older addition stays out.
async function removeMembers(
  tx: Tx,
  at: Date | undefined,
  where: SQL | undefined,
  absent: string[] = []
) {
  const named = await tx
    .select({ spaceId: spaceMembers.spaceId, userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(where)
  const changed = await fresh(tx, at, [
    ...named.map(m => memberKey(m.spaceId, m.userId)),
    ...absent
  ])
  const removed = named.filter(m => changed.has(memberKey(m.spaceId, m.userId)))
  if (removed.length === 0) return
  await tx.delete(spaceMembers).where(
    and(
      where,
      inArray(
        spaceMembers.spaceId,
        removed.map(m => m.spaceId)
      ),
      inArray(
        spaceMembers.userId,
        removed.map(m => m.userId)
      )
    )
  )
  // In one order, so two transactions cannot deadlock on their drive rows.
  for (const spaceId of [...new Set(removed.map(m => m.spaceId))].sort()) {
    const left = removed.filter(m => m.spaceId === spaceId).map(m => m.userId)
    await tx
      .delete(spaceMarks)
      .where(
        and(eq(spaceMarks.spaceId, spaceId), inArray(spaceMarks.userId, left))
      )
    await ensureDrive(tx, spaceId)
    tell(tx, 'spaces', left, { spaceId })
  }
}

const onCreated: Handler<PlatformEvent> = async (event, tx, log) => {
  const { actor, ...space } = parseOrDrop(
    spaceCreated,
    event.body,
    event.routingKey
  )
  // An organization token's write names no person.
  const createdBy = actor?.includes('@') ? actor.toLowerCase() : null
  await createSpace(tx, log, { ...space, createdBy }, space.timestamp)
}

export async function createSpace(
  tx: Tx,
  log: Logger,
  space: {
    id: string
    organizationId: string
    name: string
    createdBy: string | null
    members: z.infer<typeof member>[]
    groups: z.infer<typeof group>[]
  },
  at: Date | undefined
) {
  if (!(await fresh(tx, at, [spaceKey(space.id)])).size) return
  const renamed = (await fresh(tx, at, [spaceNameKey(space.id)])).size > 0
  // The event and the creating write's own copy can land in either order.
  const createdBy = sql`coalesce(${spaces.createdBy}, excluded.created_by)`
  await tx
    .insert(spaces)
    .values({
      spaceId: space.id,
      organizationId: space.organizationId,
      name: space.name,
      createdBy: space.createdBy
    })
    .onConflictDoUpdate({
      target: spaces.spaceId,
      set: renamed
        ? { name: space.name, updatedAt: sql`now()`, createdBy }
        : { createdBy }
    })
  await upsertMembers(tx, log, space.id, at, space.members)
  await upsertGroups(tx, space.id, at, space.groups)
  await ensureDrive(tx, space.id)
}

const onUpdated: Handler<PlatformEvent> = async (event, tx) => {
  const { id, name, timestamp } = parseOrDrop(
    spaceUpdated,
    event.body,
    event.routingKey
  )
  if (name === undefined) return
  await renameSpace(tx, id, name, timestamp)
}

export async function renameSpace(
  tx: Tx,
  id: string,
  name: string,
  at: Date | undefined
) {
  if (!(await fresh(tx, at, [spaceNameKey(id)])).size) return
  const renamed = await tx
    .update(spaces)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(spaces.spaceId, id))
    .returning({ spaceId: spaces.spaceId })
  if (renamed.length === 0) {
    // Created and then deleted, or not created yet.
    const [seen] = await tx
      .select({ at: lastChanges.at })
      .from(lastChanges)
      .where(eq(lastChanges.object, spaceKey(id)))
    if (seen) return
    throw new NotYetKnownError(`unknown space ${id}`)
  }
  await ensureDrive(tx, id)
  await tellSpaceMembers(tx, id)
}

const onDeleted: Handler<PlatformEvent> = async (event, tx) => {
  const { id, timestamp } = parseOrDrop(
    spaceEvent,
    event.body,
    event.routingKey
  )
  await deleteSpace(tx, id, timestamp, event.routingKey)
}

export async function deleteSpace(
  tx: Tx,
  id: string,
  timestamp: Date | undefined,
  actor: string
) {
  if (!(await fresh(tx, timestamp, [spaceKey(id)])).size) return
  const members = await tx
    .delete(spaceMembers)
    .where(eq(spaceMembers.spaceId, id))
    .returning({ userId: spaceMembers.userId })
  const groups = await tx
    .delete(spaceGroups)
    .where(eq(spaceGroups.spaceId, id))
    .returning({ groupId: spaceGroups.groupId })
  const resources = await tx
    .delete(spaceResources)
    .where(eq(spaceResources.spaceId, id))
    .returning({ kind: spaceResources.kind })
  // So a replayed event older than the deletion cannot bring them back.
  await fresh(tx, timestamp, [
    ...members.map(m => memberKey(id, m.userId)),
    ...groups.map(g => groupKey(id, g.groupId)),
    ...resources.map(r => resourceKey(id, r.kind))
  ])
  await dropSpaceFromTokens(tx, id, {
    actor,
    reason: 'its only space was deleted'
  })
  await tx.delete(spaceSettings).where(eq(spaceSettings.spaceId, id))
  await tx.delete(spaceBanners).where(eq(spaceBanners.spaceId, id))
  await tx.delete(spaceMarks).where(eq(spaceMarks.spaceId, id))
  const [deleted] = await tx
    .delete(spaces)
    .where(eq(spaces.spaceId, id))
    .returning({ organizationId: spaces.organizationId })
  await removeDrive(tx, id, deleted?.organizationId)
  tell(
    tx,
    'spaces',
    members.map(m => m.userId),
    { spaceId: id }
  )
}

const onMemberChanged: Handler<PlatformEvent> = async (event, tx, log) => {
  const { id, timestamp, members } = parseOrDrop(
    memberChanged,
    event.body,
    event.routingKey
  )
  await upsertMembers(tx, log, id, timestamp, members)
}

const onMemberRemoved: Handler<PlatformEvent> = async (event, tx, log) => {
  const { id, timestamp, members } = parseOrDrop(
    memberRemoved,
    event.body,
    event.routingKey
  )
  await removeSpaceMembers(tx, log, id, timestamp, members)
}

export async function removeSpaceMembers(
  tx: Tx,
  log: Logger,
  spaceId: string,
  at: Date | undefined,
  people: Person[]
) {
  const identified = await withUserIds(tx, log, people)
  await removeMembers(
    tx,
    at,
    and(eq(spaceMembers.spaceId, spaceId), matching(log, people)),
    identified.map(p => memberKey(spaceId, p.uuid))
  )
}

const onGroupChanged: Handler<PlatformEvent> = async (event, tx) => {
  const { id, timestamp, groups } = parseOrDrop(
    groupChanged,
    event.body,
    event.routingKey
  )
  await upsertGroups(tx, id, timestamp, groups)
}

const onGroupUnlinked: Handler<PlatformEvent> = async (event, tx) => {
  const { id, timestamp, groups } = parseOrDrop(
    groupUnlinked,
    event.body,
    event.routingKey
  )
  await unlinkGroups(
    tx,
    id,
    timestamp,
    groups.map(g => g.id)
  )
}

export async function unlinkGroups(
  tx: Tx,
  id: string,
  at: Date | undefined,
  groupIds: string[]
) {
  const changed = await fresh(
    tx,
    at,
    groupIds.map(g => groupKey(id, g))
  )
  if (changed.size === 0) return
  await tx.delete(spaceGroups).where(
    and(
      eq(spaceGroups.spaceId, id),
      inArray(
        spaceGroups.groupId,
        groupIds.filter(g => changed.has(groupKey(id, g)))
      )
    )
  )
  await ensureDrive(tx, id)
  await tellSpaceMembers(tx, id)
}

const groupUpdated = z.looseObject({
  id: z.uuid(),
  name: z.string().optional(),
  timestamp
})

const onGroupUpdated: Handler<PlatformEvent> = async (event, tx) => {
  const { id, name, timestamp } = parseOrDrop(
    groupUpdated,
    event.body,
    event.routingKey
  )
  if (!name) return
  if (timestamp) {
    const [newest] = await tx
      .insert(groupNames)
      .values({ groupId: id, name, renamedAt: timestamp })
      .onConflictDoUpdate({
        target: groupNames.groupId,
        set: { name, renamedAt: timestamp },
        setWhere: sql`${groupNames.renamedAt} <= excluded.renamed_at`
      })
      .returning({ groupId: groupNames.groupId })
    if (!newest) return
  }
  const linking = await tx
    .update(spaceGroups)
    .set({ name })
    .where(eq(spaceGroups.groupId, id))
    .returning({ spaceId: spaceGroups.spaceId })
  for (const { spaceId } of linking) await tellSpaceMembers(tx, spaceId)
}

// ldap-rest writes the deletion date in ISO 8601 or as an LDAP generalized
// time, like `20261005100000Z`.
function deletionDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const generalized = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(
    value
  )
  const date = generalized
    ? new Date(
        Date.UTC(
          Number(generalized[1]),
          Number(generalized[2]) - 1,
          Number(generalized[3]),
          Number(generalized[4]),
          Number(generalized[5]),
          Number(generalized[6] ?? 0)
        )
      )
    : z.iso.datetime({ offset: true }).safeParse(value).success
      ? new Date(value)
      : undefined
  return date && !isNaN(date.getTime()) ? date : undefined
}

const userDeleted = z
  .looseObject({
    uuid: z.uuid().optional(),
    internalEmail: z.email().optional(),
    timestamp,
    // ldap-rest's lifecycle event has no timestamp. An unreadable deletion
    // date must not drop the deletion.
    deletedAt: z.string().optional().transform(deletionDate).catch(undefined)
  })
  .refine(u => u.uuid ?? u.internalEmail, 'needs a uuid or an internalEmail')

const onUserDeleted: Handler<PlatformEvent> = async (event, tx, log) => {
  const deleted = parseOrDrop(userDeleted, event.body, event.routingKey)
  const { uuid, internalEmail } = deleted
  const timestamp = deleted.timestamp ?? deleted.deletedAt
  // Before removing members: the email-to-uuid lookup reads them.
  const [known] = await withUserIds(tx, log, [{ uuid, email: internalEmail }])
  await fresh(tx, timestamp, [
    ...(known ? [deletedUserKey(known.uuid)] : []),
    ...(internalEmail ? [deletedEmailKey(internalEmail)] : [])
  ])
  if (known) {
    await deleteNotificationsOf(tx, known.uuid)
    await tx.delete(spaceMarks).where(eq(spaceMarks.userId, known.uuid))
    await forgetActor(tx, {
      uuid: known.uuid,
      ...(internalEmail && { email: internalEmail })
    })
    await revokeAccountTokens(
      tx,
      { accountId: known.uuid },
      { actor: event.routingKey, reason: 'its account was deleted' }
    )
  } else if (internalEmail) {
    await forgetActor(tx, { email: internalEmail })
  }
  await removeMembers(
    tx,
    timestamp,
    matching(log, [known ?? { uuid, email: internalEmail }])
  )
  await tx
    .delete(organizationMembers)
    .where(
      or(
        uuid === undefined ? undefined : eq(organizationMembers.userId, uuid),
        internalEmail === undefined
          ? undefined
          : eq(organizationMembers.email, internalEmail)
      )
    )
  // So that whoever gets the address next does not manage these spaces.
  const email = known?.email ?? internalEmail
  if (email) {
    await tx
      .update(spaces)
      .set({ createdBy: null })
      .where(eq(spaces.createdBy, email.toLowerCase()))
  }
}

const organizationRoleChanged = z.looseObject({
  organizationId: z.string().min(1),
  uuid: z.uuid().optional(),
  email: z.email(),
  role: z.enum(organizationRole.enumValues),
  timestamp
})

const onOrganizationRoleChanged: Handler<PlatformEvent> = async (
  event,
  tx,
  log
) => {
  const change = parseOrDrop(
    organizationRoleChanged,
    event.body,
    event.routingKey
  )
  const [user] = await withUserIds(tx, log, [change])
  if (!user || (await deletedUsers(tx, user.timestamp, [user])).size) return
  const key = `organization:${user.organizationId}:member:${user.uuid}`
  if (!(await fresh(tx, user.timestamp, [key])).size) return
  await tx
    .insert(organizationMembers)
    .values({
      organizationId: user.organizationId,
      userId: user.uuid,
      email: user.email,
      role: user.role
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { email: user.email, role: user.role }
    })
}

const memberDisabled = z.looseObject({
  organizationId: z.string().min(1),
  username: z.string().min(1),
  uuid: z.uuid().optional(),
  email: z.email().optional(),
  timestamp
})

// ldap-rest sends no uuid on member events, and no email when the entry has
// no mail, but always the username.
async function accountByUsername(
  tx: Tx,
  organizationId: string,
  username: string
) {
  const [row] = await tx
    .selectDistinct({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
    .where(
      and(
        eq(spaces.organizationId, organizationId),
        eq(spaceMembers.username, username)
      )
    )
  return row?.userId
}

const onMemberDisabled: Handler<PlatformEvent> = async (event, tx, log) => {
  const disabled = parseOrDrop(memberDisabled, event.body, event.routingKey)
  const [known] = await withUserIds(tx, log, [disabled])
  const accountId =
    known?.uuid ??
    (await accountByUsername(tx, disabled.organizationId, disabled.username))
  if (!accountId) return
  await revokeAccountTokens(
    tx,
    { accountId, organizationId: disabled.organizationId },
    {
      actor: event.routingKey,
      reason: 'its account was disabled',
      before: disabled.timestamp
    }
  )
  // The stack looks members up again, and leaves out whom it no longer finds.
  const joined = await tx
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.userId, accountId),
        eq(spaces.organizationId, disabled.organizationId)
      )
    )
    .orderBy(spaceMembers.spaceId)
  for (const { spaceId } of joined) await ensureDrive(tx, spaceId)
}

const organizationDeleted = z.looseObject({
  organizationId: z.string().min(1),
  timestamp
})

const onOrganizationDeleted: Handler<PlatformEvent> = async (event, tx) => {
  const { organizationId, timestamp } = parseOrDrop(
    organizationDeleted,
    event.body,
    event.routingKey
  )
  await revokeOrganizationTokens(tx, organizationId, {
    actor: event.routingKey,
    reason: 'its organization was deleted',
    before: timestamp
  })
  const owned = await tx
    .select({ spaceId: spaces.spaceId })
    .from(spaces)
    .where(eq(spaces.organizationId, organizationId))
    .orderBy(spaces.spaceId)
  for (const { spaceId } of owned) {
    await removeDrive(tx, spaceId, organizationId)
  }
}

export const spacePlatformRoutes: ReadonlyMap<
  string,
  Handler<PlatformEvent>
> = new Map([
  ['twake.space.created', onCreated],
  ['b2b.member.role.changed', onOrganizationRoleChanged],
  ['twake.space.updated', onUpdated],
  ['twake.space.deleted', onDeleted],
  ['twake.space.member.added', onMemberChanged],
  ['twake.space.member.role.changed', onMemberChanged],
  ['twake.space.member.removed', onMemberRemoved],
  ['twake.space.group.linked', onGroupChanged],
  ['twake.space.group.role.changed', onGroupChanged],
  ['twake.space.group.unlinked', onGroupUnlinked],
  ['b2b.group.updated', onGroupUpdated],
  ['domain.user.deleted', onUserDeleted],
  ['b2b.member.disabled', onMemberDisabled],
  ['domain.organization.deleted', onOrganizationDeleted]
])
