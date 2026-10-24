import { and, eq, inArray } from 'drizzle-orm'
import { publishLater, type OutgoingEvent } from '../../events/outbox.ts'
import { outgoingActivity } from '../../events/schema.ts'
import type { Tx } from '../../infra/db.ts'
import { tell } from '../live/notify.ts'
import { notifyUsers } from '../notifications/recipients.ts'
import { notifications } from '../notifications/schema.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { activityEvents, type Actor } from './schema.ts'

const POST_MENTIONED = 'com.twake.space.post.mentioned.v1'
const SOURCE = 'twake://space'

interface Post {
  id: string
  spaceId: string
  authorId: string
  body: string
}

// One activity event per post and member: an edit that mentions someone again
// makes none, and the event backs their notification in the feed's unread
// mentions. It makes no card.
export async function mentionMembers(
  tx: Tx,
  post: Post,
  userIds: string[]
): Promise<void> {
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
  const events: OutgoingEvent[] = []
  for (const member of members) {
    if (member.userId === author.userId) continue
    const [stored] = await tx
      .insert(activityEvents)
      .values({
        source: SOURCE,
        eventId: `${post.id}:${member.userId}`,
        organizationId: space.organizationId,
        spaceId: post.spaceId,
        type: POST_MENTIONED,
        category: 'messages',
        actor,
        objectType: object.type,
        objectId: post.id,
        content: { object, preview },
        time
      })
      .onConflictDoNothing()
      .returning({ id: activityEvents.id })
    if (!stored) continue
    await notifyUsers(tx, [{ userId: member.userId, type: 'card_mention' }], {
      organizationId: space.organizationId,
      spaceId: post.spaceId,
      activityEventId: stored.id
    })
    events.push({
      specversion: '1.0',
      id: stored.id,
      source: SOURCE,
      type: POST_MENTIONED,
      time: time.toISOString(),
      twakeorg: space.organizationId,
      twakeactorid: author.userId,
      twakeactor: author.email,
      data: {
        object,
        preview,
        recipients: [
          { uuid: member.userId, email: member.email, reason: 'mentioned' }
        ]
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
