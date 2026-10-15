import { eq, inArray, or } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Tx } from '../../infra/db.ts'
import { tell } from '../live/notify.ts'
import { organizationMembers, spaceMembers, spaces } from '../spaces/schema.ts'
import {
  notifications,
  notificationSettings,
  type notificationType
} from './schema.ts'

export type NotificationType = (typeof notificationType.enumValues)[number]

export const enabledByDefault = (type: NotificationType) =>
  type !== 'space_change'

const TYPES = {
  mentioned: 'card_mention',
  invited: 'invitation',
  attendee: 'attended_event_change',
  member: 'space_change'
} as const satisfies Record<string, NotificationType>

const recipient = z.looseObject({
  uuid: z.uuid().optional(),
  email: z.email(),
  reason: z.enum(Object.keys(TYPES) as (keyof typeof TYPES)[])
})

// The people the copy holds under these uuids or emails, and whether they belong to
// the event's organization. The copy does not hold every member of an organization,
// so a uuid it does not know at all still gets its notification.
async function peopleOf(
  tx: Tx,
  organizationId: string | null,
  recipients: { uuid?: string | undefined; email: string }[]
) {
  const uuids = recipients.flatMap(r => (r.uuid ? [r.uuid] : []))
  const emails = recipients.flatMap(r => (r.uuid ? [] : [r.email]))
  if (uuids.length === 0 && emails.length === 0) return []
  const inSpaces = await tx
    .selectDistinct({
      userId: spaceMembers.userId,
      email: spaceMembers.email,
      organizationId: spaces.organizationId
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
    .where(
      or(
        inArray(spaceMembers.userId, uuids),
        inArray(spaceMembers.email, emails)
      )
    )
  const inOrganizations = await tx
    .select({
      userId: organizationMembers.userId,
      email: organizationMembers.email,
      organizationId: organizationMembers.organizationId
    })
    .from(organizationMembers)
    .where(
      or(
        inArray(organizationMembers.userId, uuids),
        inArray(organizationMembers.email, emails)
      )
    )
  return [...inSpaces, ...inOrganizations].map(p => ({
    userId: p.userId,
    email: p.email,
    here: p.organizationId === organizationId
  }))
}

export async function notifyRecipients(
  tx: Tx,
  log: Logger,
  event: {
    id: string
    organizationId: string | null
    spaceId: string | null
  },
  sent: unknown[]
) {
  // A bad entry costs that recipient only, not the card.
  const recipients = sent.flatMap(r => {
    const parsed = recipient.safeParse(r)
    return parsed.success ? [parsed.data] : []
  })
  if (recipients.length < sent.length) {
    log.warn(
      { invalid: sent.length - recipients.length },
      'skipping invalid recipients'
    )
  }
  const people = await peopleOf(tx, event.organizationId, recipients)
  const byEmail = new Map(
    people.filter(p => p.here).map(p => [p.email, p.userId])
  )
  const elsewhere = new Set(people.map(p => p.userId))
  for (const p of people) if (p.here) elsewhere.delete(p.userId)
  const wanted = recipients.flatMap(r => {
    const userId = r.uuid ?? byEmail.get(r.email)
    return userId && !elsewhere.has(userId)
      ? [{ userId, type: TYPES[r.reason] }]
      : []
  })
  if (wanted.length < recipients.length) {
    log.warn(
      { unknown: recipients.length - wanted.length },
      'recipients not found in the copy'
    )
  }
  await notifyUsers(tx, wanted, {
    organizationId: event.organizationId,
    spaceId: event.spaceId,
    activityEventId: event.id
  })
}

export async function notifyUsers(
  tx: Tx,
  wanted: { userId: string; type: NotificationType }[],
  source: {
    organizationId: string | null
    spaceId: string | null
  } & ({ activityEventId: string } | { externalId: string }),
  payload: object = {}
) {
  if (wanted.length === 0) return []

  const choices = await tx
    .select()
    .from(notificationSettings)
    .where(
      inArray(
        notificationSettings.userId,
        wanted.map(w => w.userId)
      )
    )
  const enabled = new Map(
    choices.map(c => [`${c.userId}|${c.type}`, c.enabled])
  )
  const rows = wanted
    .filter(
      w => enabled.get(`${w.userId}|${w.type}`) ?? enabledByDefault(w.type)
    )
    .map(w => ({ ...w, ...source, payload }))
  if (rows.length === 0) return []
  const inserted = await tx
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notifications.id, userId: notifications.userId })
  tell(
    tx,
    'notification',
    inserted.map(n => n.userId),
    {}
  )
  return inserted
}

export async function deleteNotificationsOf(tx: Tx, userId: string) {
  await tx.delete(notifications).where(eq(notifications.userId, userId))
}
