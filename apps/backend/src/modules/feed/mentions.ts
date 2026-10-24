import { and, eq, inArray } from 'drizzle-orm'
import { publishLater, type OutgoingEvent } from '../../events/outbox.ts'
import { outgoingActivity } from '../../events/schema.ts'
import type { Tx } from '../../infra/db.ts'
import { tell } from '../live/notify.ts'
import { notifyUsers } from '../notifications/recipients.ts'
import { notifications } from '../notifications/schema.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { activityEvents, type Actor } from './schema.ts'

const SOURCE = 'twake://space'

// Milliseconds until the key may notify again, or 0. Past the limit the post
// still names the member, without a notification. The count lives outside the
// database, so deleting the posts does not give it back.
export type MentionLimiter = (key: string) => number | Promise<number>

const REASONS = {
  mentioned: {
    type: 'com.twake.space.post.mentioned.v1',
    notification: 'card_mention',
    eventId: (postId: string, userId: string) => `${postId}:${userId}`
  },
  approval: {
    type: 'com.twake.space.post.approval_requested.v1',
    notification: 'approval_request',
    eventId: (postId: string, userId: string) => `${postId}:approval:${userId}`
  }
} as const

interface Post {
  id: string
  spaceId: string
  authorId: string
  body: string
}

export const mentionMembers = (
  tx: Tx,
  post: Post,
  userIds: string[],
  limiter: MentionLimiter
) => notifyMembers(tx, post, userIds, 'mentioned', limiter)

// An approver who is never told cannot decide, so these are never limited.
export const askApprovers = (tx: Tx, post: Post, userIds: string[]) =>
  notifyMembers(tx, post, userIds, 'approval')

// One activity event per post, member and reason: an edit that mentions
// someone again makes none, and the event backs their notification in the
// feed's unread mentions. It makes no card.
async function notifyMembers(
  tx: Tx,
  post: Post,
  userIds: string[],
  reason: keyof typeof REASONS,
  limiter?: MentionLimiter
): Promise<void> {
  const { type, notification, eventId } = REASONS[reason]
  const others = userIds.filter(id => id !== post.authorId)
  if (others.length === 0) return
  const [space] = await tx
    .select({ organizationId: spaces.organizationId, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.spaceId, post.spaceId))
  if (!space) return
  const members = await tx
    .select({ userId: spaceMembers.userId, email: spaceMembers.email })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, post.spaceId),
        inArray(spaceMembers.userId, [post.authorId, ...others])
      )
    )
  const author = members.find(m => m.userId === post.authorId)
  if (!author) return
  const actor: Actor = { type: 'user', id: author.userId, email: author.email }
  const object = {
    type: 'post',
    id: post.id,
    title: space.name,
    space: { id: post.spaceId, name: space.name }
  }
  const preview = Array.from(post.body).slice(0, 280).join('')
  const time = new Date()
  const fresh: { member: (typeof members)[number]; id: string }[] = []
  for (const member of members) {
    if (member.userId === author.userId) continue
    const [stored] = await tx
      .insert(activityEvents)
      .values({
        source: SOURCE,
        eventId: eventId(post.id, member.userId),
        organizationId: space.organizationId,
        spaceId: post.spaceId,
        type,
        category: 'messages',
        actor,
        objectType: object.type,
        objectId: post.id,
        content: { object, preview },
        time
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id })
    if (stored) fresh.push({ member, id: stored.id })
  }
  const waits = await Promise.all(
    fresh.map(async ({ member }) =>
      limiter ? limiter(`mention:${author.userId}:${member.userId}`) : 0
    )
  )
  const events: OutgoingEvent[] = []
  for (const [i, { member, id }] of fresh.entries()) {
    if (waits[i]) continue
    await notifyUsers(tx, [{ userId: member.userId, type: notification }], {
      organizationId: space.organizationId,
      spaceId: post.spaceId,
      activityEventId: id
    })
    events.push({
      specversion: '1.0',
      id,
      source: SOURCE,
      type,
      time: time.toISOString(),
      twakeorg: space.organizationId,
      twakeactorid: author.userId,
      twakeactor: author.email,
      data: {
        object,
        preview,
        recipients: [{ uuid: member.userId, email: member.email, reason }]
      }
    })
  }
  await publishLater(tx, events)
}

export async function forgetMentions(
  tx: Tx,
  spaceId: string,
  postId: string
): Promise<void> {
  const removed = await tx
    .delete(activityEvents)
    .where(
      and(
        eq(activityEvents.spaceId, spaceId),
        eq(activityEvents.objectType, 'post'),
        eq(activityEvents.objectId, postId),
        eq(activityEvents.source, SOURCE)
      )
    )
    .returning({ id: activityEvents.id })
  if (removed.length === 0) return
  const ids = removed.map(r => r.id)
  // Its outgoing event shares the mention's id: one not sent yet never is.
  await tx.delete(outgoingActivity).where(inArray(outgoingActivity.id, ids))
  const unnotified = await tx
    .delete(notifications)
    .where(inArray(notifications.activityEventId, ids))
    .returning({ userId: notifications.userId })
  tell(
    tx,
    'notification',
    unnotified.map(n => n.userId),
    {}
  )
}
