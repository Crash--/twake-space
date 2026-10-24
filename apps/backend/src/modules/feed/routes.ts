import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db, Tx } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Authorize } from '../auth/index.ts'
import type { Caller } from '../auth/routes.ts'
import { notifications } from '../notifications/schema.ts'
import { reachableSpaces } from '../spaces/routes.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { apiTokens } from '../tokens/schema.ts'
import {
  decodeCursor,
  findItem,
  listItems,
  orderOf,
  type Cursor,
  type FeedItem
} from './items.ts'
import { tellFeed } from './live.ts'
import { forgetMentions, mentionMembers } from './mentions.ts'
import {
  activityEvents,
  feedCards,
  feedCategory,
  feedItemReactions,
  feedPollVotes,
  feedPosts,
  feedReads
} from './schema.ts'

const feedQuery = z
  .object({
    category: z.enum(feedCategory.enumValues).optional(),
    before: z
      .string()
      .transform((cursor, context): Cursor => {
        const decoded = decodeCursor(cursor)
        if (decoded) return decoded
        context.addIssue({ code: 'custom', message: 'invalid cursor' })
        return z.NEVER
      })
      .optional(),
    since: z.iso
      .datetime({ offset: true })
      .transform(time => new Date(time))
      // Postgres refuses a year toISOString writes before 1 or after 9999.
      .refine(time => {
        const year = time.getUTCFullYear()
        return year >= 1 && year <= 9999
      })
      .optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  // A cursor pages the order of its page: by latest activity with since.
  .refine(({ before, since }) => !before || before.order === orderOf(since))

const spaceParams = z.object({ spaceId: z.uuid() })
const itemParams = spaceParams.extend({ itemId: z.uuid() })
const reactionParams = itemParams.extend({
  key: z.string().refine(key => {
    const length = Array.from(key).length
    return length >= 1 && length <= 16
  })
})

const postBody = z.object({
  body: z.string().trim().min(1).max(4000),
  // Member ids: anyone else is left out.
  mentions: z.array(z.uuid()).max(50).default([])
})
const newPostBody = postBody.extend({
  poll: z
    .object({
      options: z
        .array(z.string().trim().min(1).max(200))
        .min(2)
        .max(10)
        .refine(
          options =>
            new Set(options.map(o => o.toLowerCase())).size === options.length
        )
    })
    .optional()
})
const voteBody = z.object({ option: z.int().min(0) })
const readBody = z.object({ readAt: z.iso.datetime({ offset: true }) })

class Refusal extends Error {
  readonly status: number

  constructor(status: number, error: string) {
    super(error)
    this.status = status
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Refusal(400, 'invalid_request')
  return result.data
}

// A mention comes from the caller's person, a token's account included: an
// organization token has none, so it cannot mention.
function mentioner(caller: Caller, mentions: string[]): string | null {
  if (!caller.userId && mentions.length > 0) {
    throw new Refusal(403, 'cannot_mention')
  }
  return caller.userId
}

const serialize = (item: FeedItem) => ({
  ...item,
  time: item.time.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  ...(item.kind === 'post' && {
    editedAt: item.editedAt?.toISOString() ?? null,
    poll: item.poll && {
      ...item.poll,
      closedAt: item.poll.closedAt?.toISOString() ?? null
    }
  })
})

export function registerFeedRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize }
) {
  const { db } = deps
  const read = deps.authorize('feed:read')
  const write = deps.authorize('feed:write')
  // Reactions, votes and read marks are a person's own, so no token gets them.
  const preHandler = deps.authorize()

  // Unknown ids answer 404 like spaces the caller is not in.
  async function reach(request: FastifyRequest) {
    const caller = request.caller
    if (!caller) throw new Error('authorize let a request through')
    const params = spaceParams.safeParse(request.params)
    if (!params.success) throw new Refusal(404, 'not_found')
    const [space] = await reachableSpaces(db, caller, params.data.spaceId)
    if (!space) throw new Refusal(404, 'not_found')
    return { caller, space }
  }

  async function memberOf(request: FastifyRequest) {
    const { caller, space } = await reach(request)
    if (caller.kind !== 'session') {
      throw new Error('authorize let a request through')
    }
    return { spaceId: space.id, role: space.role, userId: caller.userId }
  }

  function itemOf(request: FastifyRequest) {
    const params = itemParams.safeParse(request.params)
    if (!params.success) throw new Refusal(404, 'not_found')
    return params.data.itemId
  }

  async function authoredPost(tx: Tx, request: FastifyRequest) {
    const { caller, space } = await reach(request)
    const spaceId = space.id
    const postId = itemOf(request)
    const [post] = await tx
      .select({
        authorId: feedPosts.authorId,
        authorTokenId: feedPosts.authorTokenId,
        tokenAccountId: apiTokens.accountId
      })
      .from(feedPosts)
      .leftJoin(apiTokens, eq(apiTokens.id, feedPosts.authorTokenId))
      .where(and(eq(feedPosts.id, postId), eq(feedPosts.spaceId, spaceId)))
      .for('update', { of: feedPosts })
    if (!post) throw new Refusal(404, 'not_found')
    // A person also answers for the posts of their own tokens, revoked ones
    // included.
    const authored =
      caller.kind === 'token'
        ? post.authorTokenId === caller.tokenId
        : post.authorId === caller.userId ||
          post.tokenAccountId === caller.userId
    if (!authored) throw new Refusal(403, 'not_author')
    return { spaceId, postId, caller }
  }

  // Shared: a vote waits for the poll's closing, and the closing for the vote.
  async function openPoll(tx: Tx, spaceId: string, postId: string) {
    const [post] = await tx
      .select({
        options: feedPosts.pollOptions,
        closedAt: feedPosts.pollClosedAt
      })
      .from(feedPosts)
      .where(and(eq(feedPosts.id, postId), eq(feedPosts.spaceId, spaceId)))
      .for('share')
    if (!post?.options) throw new Refusal(404, 'not_found')
    if (post.closedAt) throw new Refusal(409, 'poll_closed')
    return post.options
  }

  async function existingItem(tx: Tx, spaceId: string, itemId: string) {
    const [card] = await tx
      .select({ id: feedCards.id })
      .from(feedCards)
      .where(and(eq(feedCards.id, itemId), eq(feedCards.spaceId, spaceId)))
    if (card) return
    const [post] = await tx
      .select({ id: feedPosts.id })
      .from(feedPosts)
      .where(and(eq(feedPosts.id, itemId), eq(feedPosts.spaceId, spaceId)))
    if (!post) throw new Refusal(404, 'not_found')
  }

  const refused = (error: unknown, reply: FastifyReply) => {
    if (!(error instanceof Refusal)) throw error
    return reply.code(error.status).send({ error: error.message })
  }

  app.get(
    '/spaces/:spaceId/feed',
    { preHandler: read },
    async (request, reply) => {
      try {
        const spaceId = (await reach(request)).space.id
        const { category, before, since, q, limit } = parse(
          feedQuery,
          request.query
        )
        const page = await listItems(db, spaceId, {
          limit,
          ...(category && { category }),
          ...(before && { before }),
          ...(since && { since }),
          ...(q && { q })
        })
        return { items: page.items.map(serialize), next: page.next }
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.get(
    '/spaces/:spaceId/feed/items/:itemId',
    { preHandler: read },
    async (request, reply) => {
      try {
        const spaceId = (await reach(request)).space.id
        const item = await findItem(db, spaceId, itemOf(request))
        if (!item) throw new Refusal(404, 'not_found')
        return serialize(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // A feed never opened has no mark, so nothing in it counts as new, as in
  // the feed itself; its mentions still do. A mention older than the mark was
  // seen in the feed, even though its notification may stay unread.
  app.get('/feed/unread', { preHandler }, async request => {
    const caller = request.caller
    if (caller?.kind !== 'session') {
      throw new Error('authorize let a request through')
    }
    const newer = (table: typeof feedCards | typeof feedPosts) =>
      sql<number>`(select count(*)::int from ${table}
        where ${table.spaceId} = ${spaceMembers.spaceId}
        and ${table.time} > ${feedReads.readAt})`
    const rows = await db
      .select({
        spaceId: spaceMembers.spaceId,
        items: sql<number>`${newer(feedCards)} + ${newer(feedPosts)}`,
        mentions: sql<number>`(select count(*)::int from ${notifications}
          join ${activityEvents}
            on ${activityEvents.id} = ${notifications.activityEventId}
          where ${notifications.userId} = ${caller.userId}
          and ${notifications.spaceId} = ${spaceMembers.spaceId}
          and ${notifications.type} = 'card_mention'
          and ${notifications.readAt} is null
          and (${feedReads.readAt} is null
            or ${activityEvents.time} > ${feedReads.readAt}))`
      })
      .from(spaceMembers)
      .innerJoin(
        spaces,
        and(
          eq(spaces.spaceId, spaceMembers.spaceId),
          eq(spaces.organizationId, caller.organizationId),
          eq(spaces.state, 'active')
        )
      )
      .leftJoin(
        feedReads,
        and(
          eq(feedReads.spaceId, spaceMembers.spaceId),
          eq(feedReads.userId, spaceMembers.userId)
        )
      )
      .where(eq(spaceMembers.userId, caller.userId))
    return { spaces: rows.filter(row => row.items > 0 || row.mentions > 0) }
  })

  app.get(
    '/spaces/:spaceId/feed/read',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const [read] = await db
          .select({ readAt: feedReads.readAt })
          .from(feedReads)
          .where(
            and(eq(feedReads.spaceId, spaceId), eq(feedReads.userId, userId))
          )
        return { readAt: read?.readAt.toISOString() ?? null }
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // Only moves forward: another tab still on older items leaves it alone. A
  // time to come would hide every new item until then: it counts as now.
  app.put(
    '/spaces/:spaceId/feed/read',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const sent = Date.parse(parse(readBody, request.body).readAt)
        const readAt = new Date(Math.min(sent, Date.now()))
        await db
          .insert(feedReads)
          .values({ spaceId, userId, readAt })
          .onConflictDoUpdate({
            target: [feedReads.spaceId, feedReads.userId],
            set: {
              readAt: sql`greatest(${feedReads.readAt}, excluded.read_at)`
            }
          })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.post(
    '/spaces/:spaceId/feed/posts',
    { preHandler: write },
    async (request, reply) => {
      try {
        const { caller, space } = await reach(request)
        const spaceId = space.id
        if (space.role === 'viewer') throw new Refusal(403, 'cannot_post')
        const { body, poll, mentions } = parse(newPostBody, request.body)
        const speaker = mentioner(caller, mentions)
        const item = await db.transaction(async tx => {
          const [post] = await tx
            .insert(feedPosts)
            .values({
              spaceId,
              ...(caller.kind === 'token'
                ? { authorTokenId: caller.tokenId }
                : { authorId: caller.userId }),
              body,
              time: new Date(),
              pollOptions: poll?.options ?? null
            })
            .returning({ id: feedPosts.id })
          if (!post) throw new Error('the post insert returned no row')
          if (speaker) {
            await mentionMembers(
              tx,
              { id: post.id, spaceId, authorId: speaker, body },
              mentions
            )
          }
          await tellFeed(tx, spaceId, post.id, 'added')
          return findItem(tx, spaceId, post.id)
        })
        if (!item) throw new Error('the new post is not found')
        return await reply.code(201).send(serialize(item))
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.patch(
    '/spaces/:spaceId/feed/posts/:itemId',
    { preHandler: write },
    async (request, reply) => {
      try {
        const item = await db.transaction(async tx => {
          const { spaceId, postId, caller } = await authoredPost(tx, request)
          const { body, mentions } = parse(postBody, request.body)
          const speaker = mentioner(caller, mentions)
          await tx
            .update(feedPosts)
            .set({ body, editedAt: new Date() })
            .where(eq(feedPosts.id, postId))
          if (speaker) {
            await mentionMembers(
              tx,
              { id: postId, spaceId, authorId: speaker, body },
              mentions
            )
          }
          await tellFeed(tx, spaceId, postId, 'changed')
          return findItem(tx, spaceId, postId)
        })
        if (!item) throw new Error('the edited post is not found')
        return serialize(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.delete(
    '/spaces/:spaceId/feed/posts/:itemId',
    { preHandler: write },
    async (request, reply) => {
      try {
        await db.transaction(async tx => {
          const { spaceId, postId } = await authoredPost(tx, request)
          await tx.delete(feedPosts).where(eq(feedPosts.id, postId))
          await tx
            .delete(feedItemReactions)
            .where(eq(feedItemReactions.itemId, postId))
          await forgetMentions(tx, spaceId, postId)
          await tellFeed(tx, spaceId, postId, 'removed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.put(
    '/spaces/:spaceId/feed/posts/:itemId/vote',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const postId = itemOf(request)
        const { option } = parse(voteBody, request.body)
        await db.transaction(async tx => {
          const options = await openPoll(tx, spaceId, postId)
          if (option >= options.length) {
            throw new Refusal(400, 'invalid_request')
          }
          const [voted] = await tx
            .insert(feedPollVotes)
            .values({ postId, userId, option })
            .onConflictDoUpdate({
              target: [feedPollVotes.postId, feedPollVotes.userId],
              set: { option, createdAt: new Date() },
              setWhere: ne(feedPollVotes.option, option)
            })
            .returning({ postId: feedPollVotes.postId })
          if (voted) await tellFeed(tx, spaceId, postId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.delete(
    '/spaces/:spaceId/feed/posts/:itemId/vote',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const postId = itemOf(request)
        await db.transaction(async tx => {
          await openPoll(tx, spaceId, postId)
          const [removed] = await tx
            .delete(feedPollVotes)
            .where(
              and(
                eq(feedPollVotes.postId, postId),
                eq(feedPollVotes.userId, userId)
              )
            )
            .returning({ postId: feedPollVotes.postId })
          if (removed) await tellFeed(tx, spaceId, postId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // Closing again keeps the first time.
  app.post(
    '/spaces/:spaceId/feed/posts/:itemId/close',
    { preHandler: write },
    async (request, reply) => {
      try {
        const item = await db.transaction(async tx => {
          const { spaceId, postId } = await authoredPost(tx, request)
          const [closed] = await tx
            .update(feedPosts)
            .set({ pollClosedAt: new Date() })
            .where(
              and(
                eq(feedPosts.id, postId),
                isNotNull(feedPosts.pollOptions),
                isNull(feedPosts.pollClosedAt)
              )
            )
            .returning({ id: feedPosts.id })
          if (closed) await tellFeed(tx, spaceId, postId, 'changed')
          return findItem(tx, spaceId, postId)
        })
        if (item?.kind !== 'post' || !item.poll) {
          throw new Refusal(404, 'not_found')
        }
        return serialize(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.put(
    '/spaces/:spaceId/feed/items/:itemId/reactions/:key',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const { itemId, key } = parse(reactionParams, request.params)
        await db.transaction(async tx => {
          await existingItem(tx, spaceId, itemId)
          const [added] = await tx
            .insert(feedItemReactions)
            .values({ itemId, spaceId, userId, key })
            .onConflictDoNothing()
            .returning({ itemId: feedItemReactions.itemId })
          if (added) await tellFeed(tx, spaceId, itemId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.delete(
    '/spaces/:spaceId/feed/items/:itemId/reactions/:key',
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const { itemId, key } = parse(reactionParams, request.params)
        await db.transaction(async tx => {
          const [removed] = await tx
            .delete(feedItemReactions)
            .where(
              and(
                eq(feedItemReactions.itemId, itemId),
                eq(feedItemReactions.spaceId, spaceId),
                eq(feedItemReactions.userId, userId),
                eq(feedItemReactions.key, key)
              )
            )
            .returning({ itemId: feedItemReactions.itemId })
          if (removed) await tellFeed(tx, spaceId, itemId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )
}
