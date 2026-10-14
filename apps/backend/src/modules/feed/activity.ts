import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { CloudEvent } from '../../events/envelope.ts'
import { deletedEmailKey, deletedUserKey } from '../../events/freshness.ts'
import { WAIT_SECONDS } from '../../events/parking.ts'
import { lastChanges } from '../../events/schema.ts'
import {
  NotYetKnownError,
  parseOrDrop,
  RejectedEventError,
  type Handler
} from '../../events/router.ts'
import type { Tx } from '../../infra/db.ts'
import { notifyRecipients } from '../notifications/recipients.ts'
import {
  spaceMembers,
  spaceResourceKind,
  spaceResources
} from '../spaces/schema.ts'
import { FOLDER_DIGEST } from './items.ts'
import { tellFeed } from './live.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPosts,
  feedReads,
  type Actor,
  type feedCategory
} from './schema.ts'

type Category = (typeof feedCategory.enumValues)[number]
type SpaceResourceKind = (typeof spaceResourceKind.enumValues)[number]

// Chat makes no card: its messages are already in Matrix.
const CATEGORIES: Record<string, Category> = {
  mail: 'messages',
  drive: 'files',
  calendar: 'events',
  meet: 'activities',
  tasks: 'activities'
}

const activity = z.looseObject({
  twakeorg: z.string().min(1).optional(),
  twakeactorid: z.uuid().optional(),
  twakeactor: z.email().optional(),
  data: z.looseObject({
    object: z.looseObject({
      type: z.string().min(1),
      id: z.string().min(1),
      // The app's own resource the object lives in.
      container: z
        .looseObject({
          kind: z.enum(spaceResourceKind.enumValues),
          id: z.string().min(1)
        })
        .optional(),
      title: z.string().min(1)
    }),
    preview: z
      .string()
      .transform(p => Array.from(p).slice(0, 280).join(''))
      .optional(),
    actor: z
      .looseObject({
        type: z.literal('token'),
        id: z.string().min(1),
        name: z.string().min(1)
      })
      .optional(),
    recipients: z.array(z.unknown()).default([])
  })
})

async function findUser(
  tx: Tx,
  spaceId: string | undefined,
  id: string | undefined,
  email: string | undefined
): Promise<Actor | null> {
  if (id) return { type: 'user', id, email: email ?? null }
  if (!email) return null
  const [member] = await tx
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.email, email),
        spaceId ? eq(spaceMembers.spaceId, spaceId) : undefined
      )
    )
    .limit(1)
  return { type: 'user', id: member?.userId ?? null, email }
}

interface Container {
  kind: SpaceResourceKind
  id: string
}

// Events on a container read its space under the shared lock, and its
// provisioned event attaches them under the exclusive one, so neither commits
// unseen by the other.
async function lockContainer(
  tx: Tx,
  { kind, id }: Container,
  mode: 'shared' | 'exclusive'
) {
  const key = `container:${kind}:${id}`
  await tx.execute(
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${key}))`
      : sql`select pg_advisory_xact_lock(hashtext(${key}))`
  )
}

// A resource no space has belongs to a person: notifications only, unless its
// provisioned event comes later and attaches the event to its space.
async function findSpace(
  tx: Tx,
  container: Container | undefined,
  organizationId: string | undefined
): Promise<string | undefined> {
  if (!container) return undefined
  await lockContainer(tx, container, 'shared')
  const holders = await tx
    .select({
      spaceId: spaceResources.spaceId,
      organizationId: spaceResources.organizationId
    })
    .from(spaceResources)
    .where(
      and(
        eq(spaceResources.kind, container.kind),
        eq(spaceResources.resourceId, container.id)
      )
    )
  const holder = holders.find(h => h.organizationId === organizationId)
  if (holder) return holder.spaceId
  // So a resource id never shows content to another organization's space.
  if (holders.length > 0) {
    throw new RejectedEventError(
      `${container.kind} ${container.id} is not in organization ${organizationId ?? 'none'}`
    )
  }
  return undefined
}

// Its deletion may have been handled before this older event.
async function deletedBefore(tx: Tx, actor: Actor | null, at: Date) {
  if (actor?.type !== 'user') return false
  const keys = [
    ...(actor.id ? [deletedUserKey(actor.id)] : []),
    ...(actor.email ? [deletedEmailKey(actor.email)] : [])
  ]
  if (keys.length === 0) return false
  const [deletion] = await tx
    .select({ at: lastChanges.at })
    .from(lastChanges)
    .where(and(inArray(lastChanges.object, keys), gt(lastChanges.at, at)))
    .limit(1)
  return deletion !== undefined
}

async function checkActor(tx: Tx, spaceId: string, actor: Actor | null) {
  if (actor?.type !== 'user') return
  // Sent by email only and no member has it: someone outside the space, such
  // as an attendee replying to a team calendar event.
  if (!actor.id) return
  const [member] = await tx
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(
      and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, actor.id))
    )
  if (!member) {
    throw new NotYetKnownError(`actor is not a member of space ${spaceId}`)
  }
}

interface StoredEvent {
  id: string
  spaceId: string
  type: string
  actor: Actor | null
  objectType: string
  objectId: string
  category: Category
  time: Date
}

// The card shows the object's latest event, whatever order the events arrive
// in. It keeps the place of the first, but a folder digest, one per member
// (cozy-stack ADR 010), takes the place of its latest window.
async function showCard(tx: Tx, event: StoredEvent) {
  const digest = event.type === FOLDER_DIGEST
  const [shown] = await tx
    .insert(feedCards)
    .values({
      spaceId: event.spaceId,
      objectType: event.objectType,
      objectId: event.objectId,
      memberId: digest && event.actor?.type === 'user' ? event.actor.id : null,
      category: event.category,
      time: event.time,
      latestEventId: event.id,
      latestTime: event.time
    })
    .onConflictDoUpdate({
      target: [
        feedCards.spaceId,
        feedCards.objectType,
        feedCards.objectId,
        feedCards.memberId
      ],
      set: {
        time: digest
          ? sql`greatest(${feedCards.time}, excluded.time)`
          : sql`least(${feedCards.time}, excluded.time)`,
        latestEventId: sql`case when excluded.latest_time >= ${feedCards.latestTime}
          then excluded.latest_event_id else ${feedCards.latestEventId} end`,
        latestTime: sql`greatest(${feedCards.latestTime}, excluded.latest_time)`
      }
    })
    .returning({ id: feedCards.id, added: sql<boolean>`xmax = 0` })
  if (!shown) throw new Error('the card upsert returned no row')
  await tellFeed(tx, event.spaceId, shown.id, shown.added ? 'added' : 'changed')
}

// Only events that came within the wait for a late event: an older one on the
// same container was a person's before the space had it.
export async function attachToSpace(
  tx: Tx,
  spaceId: string,
  organizationId: string,
  container: Container
) {
  await lockContainer(tx, container, 'exclusive')
  const object = sql`${activityEvents.content}->'object'->'container'`
  const attached = await tx
    .update(activityEvents)
    .set({ spaceId })
    .where(
      and(
        isNull(activityEvents.spaceId),
        eq(activityEvents.organizationId, organizationId),
        sql`${object}->>'kind' = ${container.kind}`,
        sql`${object}->>'id' = ${container.id}`,
        sql`${activityEvents.createdAt} > now() - make_interval(secs => ${WAIT_SECONDS})`
      )
    )
    .returning({
      id: activityEvents.id,
      type: activityEvents.type,
      actor: activityEvents.actor,
      objectType: activityEvents.objectType,
      objectId: activityEvents.objectId,
      category: activityEvents.category,
      time: activityEvents.time
    })
  for (const event of attached) {
    await showCard(tx, { ...event, spaceId })
  }
}

function store(category: Category): Handler<CloudEvent> {
  return async (event, tx, log) => {
    const { twakeorg, twakeactorid, twakeactor, data } = parseOrDrop(
      activity,
      event,
      event.type
    )
    const spaceId = await findSpace(tx, data.object.container, twakeorg)
    const time = event.time ? new Date(event.time) : new Date()
    const found: Actor | null = data.actor
      ? { type: 'token', id: data.actor.id, name: data.actor.name }
      : await findUser(tx, spaceId, twakeactorid, twakeactor)
    const actor: Actor | null = (await deletedBefore(tx, found, time))
      ? { type: 'deleted_user' }
      : found
    if (spaceId) await checkActor(tx, spaceId, actor)
    // Recipients stay out of the card every space member sees.
    const { recipients, ...content } = data
    const organizationId = twakeorg ?? null
    const [stored] = await tx
      .insert(activityEvents)
      .values({
        source: event.source,
        eventId: event.id,
        organizationId,
        spaceId: spaceId ?? null,
        type: event.type,
        category,
        actor,
        objectType: data.object.type,
        objectId: data.object.id,
        content,
        time
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id, time: activityEvents.time })
    // Replayed under another consumer group: stored and notified already.
    if (!stored) return
    if (spaceId) {
      await showCard(tx, {
        id: stored.id,
        spaceId,
        type: event.type,
        actor,
        objectType: data.object.type,
        objectId: data.object.id,
        category,
        time: stored.time
      })
    }
    // Twake Tasks notifies its own users.
    if (event.type.startsWith('com.twake.tasks.')) return
    await notifyRecipients(
      tx,
      log,
      { id: stored.id, organizationId, spaceId: spaceId ?? null },
      recipients
    )
  }
}

const handlers = new Map(
  Object.entries(CATEGORIES).map(([app, category]) => [app, store(category)])
)

export async function forgetActor(
  tx: Tx,
  user: { uuid: string; email?: string } | { uuid?: never; email: string }
) {
  const { uuid, email } = user
  if (uuid) {
    await tx
      .update(feedPosts)
      .set({ authorId: null })
      .where(eq(feedPosts.authorId, uuid))
    await tx.delete(feedItemReactions).where(eq(feedItemReactions.userId, uuid))
    await tx.delete(feedReads).where(eq(feedReads.userId, uuid))
    // Not null: the unique key treats nulls as equal, so the card would clash
    // with any other card on the folder that has no member.
    await tx
      .update(feedCards)
      .set({ memberId: sql`gen_random_uuid()` })
      .where(eq(feedCards.memberId, uuid))
  }
  // An actor sent by email only keeps a null id, so the email matches it too.
  await tx
    .update(activityEvents)
    .set({ actor: { type: 'deleted_user' } satisfies Actor })
    .where(
      and(
        sql`${activityEvents.actor}->>'type' = 'user'`,
        or(
          uuid ? sql`${activityEvents.actor}->>'id' = ${uuid}` : undefined,
          email ? sql`${activityEvents.actor}->>'email' = ${email}` : undefined
        )
      )
    )
}

export const activityRoute = {
  get(type: string): Handler<CloudEvent> | undefined {
    const app = /^com\.twake\.([a-z]+)\./.exec(type)?.[1]
    if (
      !app ||
      type.includes('.space.provisioned.') ||
      type.includes('.org_drive.')
    ) {
      return undefined
    }
    return handlers.get(app)
  }
}
