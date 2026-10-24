import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  or,
  sql,
  type Column
} from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { Db, Tx } from '../../infra/db.ts'
import { spaceMembers } from '../spaces/schema.ts'
import { apiTokens } from '../tokens/schema.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPosts,
  type Actor,
  type feedCategory
} from './schema.ts'

export type Category = (typeof feedCategory.enumValues)[number]

export interface StoredContent {
  object: {
    type: string
    id: string
    title: string
    container?: { kind: string; id: string }
  }
  preview?: string
  state?: unknown
  files?: unknown
  samples?: unknown
}

export const FOLDER_DIGEST = 'com.twake.drive.folder.changed.v1'

const count = z.int().positive().catch(0)

// Apps send data.files and data.samples unchecked.
const folderDigest = z
  .object({
    files: z.object({ created: count, updated: count, deleted: count }),
    samples: z
      .array(z.unknown())
      .catch([])
      .transform(samples =>
        samples.filter(s => typeof s === 'string').slice(0, 5)
      )
  })
  .transform(({ files, samples }) => ({ ...files, samples }))
  .nullable()
  .catch(null)

type Files = NonNullable<z.output<typeof folderDigest>>

function toFiles(type: string, content: StoredContent): Files | null {
  return type === FOLDER_DIGEST ? folderDigest.parse(content) : null
}

type NamedActor =
  | { type: 'user'; id: string | null; name: string | null }
  | { type: 'token'; id: string; name: string }
  | { type: 'deleted_user' }

interface Reaction {
  key: string
  userIds: string[]
}

interface Common {
  id: string
  category: Category
  time: Date
  updatedAt: Date
  reactions: Reaction[]
}

export type FeedItem =
  | (Common & {
      kind: 'card'
      type: string
      actor: NamedActor | null
      object: {
        type: string
        id: string
        title: string
        container: { kind: string; id: string } | null
      }
      preview: string | null
      state: object
      files: Files | null
    })
  | (Common & {
      kind: 'post'
      author: NamedActor
      body: string
      editedAt: Date | null
    })

// Newest first by time, or by latest activity for the items active since an
// instant.
export type Order = 'time' | 'activity'

export function orderOf(since: Date | undefined): Order {
  return since ? 'activity' : 'time'
}

export interface Cursor {
  order: Order
  time: Date
  id: string
}

// A cursor of the activity order says so, so that a page of one order never
// follows a cursor of the other.
export function encodeCursor(cursor: Cursor): string {
  const fields = [cursor.time.toISOString(), cursor.id]
  if (cursor.order === 'activity') fields.push('activity')
  return Buffer.from(fields.join('|')).toString('base64url')
}

export function decodeCursor(cursor: string): Cursor | null {
  const [time, id, order, ...rest] = Buffer.from(cursor, 'base64url')
    .toString()
    .split('|')
  if (!time || !id || rest.length > 0) return null
  if (order !== undefined && order !== 'activity') return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) return null
  return { order: order ?? 'time', time: date, id }
}

// Cards and posts in one order. With since, the items active since then, newest
// activity first: a card by its latest event, even when its first is older, a
// post by its time. Every time is written from a JS Date, so the cursor's
// milliseconds lose nothing.
export async function listItems(
  db: Db,
  spaceId: string,
  options: {
    category?: Category
    before?: Cursor
    q?: string
    since?: Date
    limit: number
  }
): Promise<{ items: FeedItem[]; next: string | null }> {
  const { category, before, q, since, limit } = options
  const after = (time: Column, id: Column) =>
    before &&
    sql`(${time}, ${id}) < (${before.time.toISOString()}::timestamptz, ${before.id}::uuid)`
  const active = (time: Column) => since && gte(time, since)
  const order = orderOf(since)
  const cardTime = order === 'activity' ? feedCards.latestTime : feedCards.time
  const pattern = q && `%${q.replace(/[\\%_]/g, '\\$&')}%`
  // A card matches on what it shows: its latest event's title and preview.
  const cardMatches =
    pattern === undefined
      ? undefined
      : exists(
          db
            .select({ id: activityEvents.id })
            .from(activityEvents)
            .where(
              and(
                eq(activityEvents.id, feedCards.latestEventId),
                or(
                  ilike(
                    sql`${activityEvents.content}->'object'->>'title'`,
                    pattern
                  ),
                  ilike(sql`${activityEvents.content}->>'preview'`, pattern)
                )
              )
            )
        )
  const cards = db
    .select({
      kind: sql<'card' | 'post'>`'card'`.as('kind'),
      id: feedCards.id,
      // Named time either way, which the order and the cursor read.
      time: sql`${cardTime}`.mapWith(cardTime).as('time')
    })
    .from(feedCards)
    .where(
      and(
        eq(feedCards.spaceId, spaceId),
        category && eq(feedCards.category, category),
        after(cardTime, feedCards.id),
        active(cardTime),
        cardMatches
      )
    )
  const posts = db
    .select({
      kind: sql<'card' | 'post'>`'post'`.as('kind'),
      id: feedPosts.id,
      time: feedPosts.time
    })
    .from(feedPosts)
    .where(
      and(
        eq(feedPosts.spaceId, spaceId),
        after(feedPosts.time, feedPosts.id),
        active(feedPosts.time),
        pattern === undefined ? undefined : ilike(feedPosts.body, pattern)
      )
    )
  const page = await (
    category && category !== 'messages' ? cards : unionAll(cards, posts)
  )
    .orderBy(desc(sql`time`), desc(sql`id`))
    .limit(limit + 1)
  const shown = page.slice(0, limit)
  const items = await loadItems(db, spaceId, shown)
  const last = shown.at(-1)
  return {
    items: shown.flatMap(row => items.get(row.id) ?? []),
    next:
      page.length > limit && last
        ? encodeCursor({ order, time: last.time, id: last.id })
        : null
  }
}

export async function findItem(
  db: Db | Tx,
  spaceId: string,
  itemId: string
): Promise<FeedItem | undefined> {
  const items = await loadItems(db, spaceId, [
    { kind: 'card', id: itemId },
    { kind: 'post', id: itemId }
  ])
  return items.get(itemId)
}

async function loadItems(
  db: Db | Tx,
  spaceId: string,
  rows: { kind: 'card' | 'post'; id: string }[]
): Promise<Map<string, FeedItem>> {
  const cardIds = rows.filter(r => r.kind === 'card').map(r => r.id)
  const postIds = rows.filter(r => r.kind === 'post').map(r => r.id)
  const items = new Map<string, FeedItem>()
  if (rows.length === 0) return items
  const [cards, posts, reactions] = await Promise.all([
    cardIds.length === 0
      ? []
      : db
          .select({
            id: feedCards.id,
            category: feedCards.category,
            time: feedCards.time,
            updatedAt: feedCards.latestTime,
            type: activityEvents.type,
            actor: activityEvents.actor,
            content: activityEvents.content
          })
          .from(feedCards)
          .innerJoin(
            activityEvents,
            eq(activityEvents.id, feedCards.latestEventId)
          )
          .where(
            and(eq(feedCards.spaceId, spaceId), inArray(feedCards.id, cardIds))
          ),
    postIds.length === 0
      ? []
      : db
          .select({ post: feedPosts, tokenName: apiTokens.name })
          .from(feedPosts)
          .leftJoin(apiTokens, eq(apiTokens.id, feedPosts.authorTokenId))
          .where(
            and(eq(feedPosts.spaceId, spaceId), inArray(feedPosts.id, postIds))
          ),
    db
      .select({
        itemId: feedItemReactions.itemId,
        key: feedItemReactions.key,
        userIds: sql<
          string[]
        >`array_agg(${feedItemReactions.userId}::text order by ${feedItemReactions.createdAt}, ${feedItemReactions.userId})`
      })
      .from(feedItemReactions)
      .where(
        and(
          eq(feedItemReactions.spaceId, spaceId),
          inArray(
            feedItemReactions.itemId,
            rows.map(r => r.id)
          )
        )
      )
      .groupBy(feedItemReactions.itemId, feedItemReactions.key)
      .orderBy(
        asc(sql`min(${feedItemReactions.createdAt})`),
        asc(feedItemReactions.key)
      )
  ])
  const userIds = [
    ...cards.map(c => (c.actor?.type === 'user' ? c.actor.id : null)),
    ...posts.map(p => p.post.authorId)
  ].filter(id => id !== null)
  const names = await memberNames(db, spaceId, userIds)
  const named = (actor: Actor | null): NamedActor | null => {
    if (actor?.type !== 'user') return actor
    return {
      type: 'user',
      id: actor.id,
      name: (actor.id && names.get(actor.id)) ?? null
    }
  }
  const byItem = Map.groupBy(reactions, r => r.itemId)
  const reactionsOf = (itemId: string) =>
    (byItem.get(itemId) ?? []).map(({ key, userIds }) => ({ key, userIds }))
  for (const card of cards) {
    const content = card.content as StoredContent
    const { type, id, title, container } = content.object
    items.set(card.id, {
      id: card.id,
      kind: 'card',
      category: card.category,
      time: card.time,
      updatedAt: card.updatedAt,
      type: card.type,
      actor: named(card.actor),
      object: {
        type,
        id,
        title,
        container: container ? { kind: container.kind, id: container.id } : null
      },
      preview: content.preview ?? null,
      // Apps send data.state unchecked.
      state:
        typeof content.state === 'object' &&
        content.state !== null &&
        !Array.isArray(content.state)
          ? content.state
          : {},
      files: toFiles(card.type, content),
      reactions: reactionsOf(card.id)
    })
  }
  for (const { post, tokenName } of posts) {
    items.set(post.id, {
      id: post.id,
      kind: 'post',
      category: 'messages',
      time: post.time,
      updatedAt: post.editedAt ?? post.time,
      author:
        post.authorTokenId && tokenName !== null
          ? { type: 'token', id: post.authorTokenId, name: tokenName }
          : post.authorId
            ? {
                type: 'user',
                id: post.authorId,
                name: names.get(post.authorId) ?? null
              }
            : { type: 'deleted_user' },
      body: post.body,
      editedAt: post.editedAt,
      reactions: reactionsOf(post.id)
    })
  }
  return items
}

async function memberNames(db: Db | Tx, spaceId: string, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>()
  const members = await db
    .select({
      userId: spaceMembers.userId,
      username: spaceMembers.username,
      displayName: spaceMembers.displayName
    })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, spaceId),
        inArray(spaceMembers.userId, [...new Set(userIds)])
      )
    )
  return new Map(members.map(m => [m.userId, m.displayName ?? m.username]))
}
