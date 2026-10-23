import { and, eq, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db, Tx } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Authorize } from '../auth/index.ts'
import { reachableSpaces } from '../spaces/routes.ts'
import {
  decodeCursor,
  findItem,
  listItems,
  orderOf,
  type Cursor,
  type FeedItem
} from './items.ts'
import { tellFeed } from './live.ts'
import {
  feedCards,
  feedCategory,
  feedItemReactions,
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

const postBody = z.object({ body: z.string().trim().min(1).max(4000) })
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

const serialize = (item: FeedItem) => ({
  ...item,
  time: item.time.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  ...(item.kind === 'post' && {
    editedAt: item.editedAt?.toISOString() ?? null
  })
})

export function registerFeedRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize }
) {
  const { db } = deps
  // Tokens only read: posts and reactions are a person's own.
  const read = deps.authorize('feed:read')
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
    const { spaceId, userId } = await memberOf(request)
    const postId = itemOf(request)
    const [post] = await tx
      .select({ authorId: feedPosts.authorId })
      .from(feedPosts)
      .where(and(eq(feedPosts.id, postId), eq(feedPosts.spaceId, spaceId)))
      .for('update')
    if (!post) throw new Refusal(404, 'not_found')
    if (post.authorId !== userId) throw new Refusal(403, 'not_author')
    return { spaceId, postId }
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
    { preHandler },
    async (request, reply) => {
      try {
        const { spaceId, role, userId } = await memberOf(request)
        if (role === 'viewer') throw new Refusal(403, 'cannot_post')
        const { body } = parse(postBody, request.body)
        const item = await db.transaction(async tx => {
          const [post] = await tx
            .insert(feedPosts)
            .values({ spaceId, authorId: userId, body, time: new Date() })
            .returning({ id: feedPosts.id })
          if (!post) throw new Error('the post insert returned no row')
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
    { preHandler },
    async (request, reply) => {
      try {
        const item = await db.transaction(async tx => {
          const { spaceId, postId } = await authoredPost(tx, request)
          const { body } = parse(postBody, request.body)
          await tx
            .update(feedPosts)
            .set({ body, editedAt: new Date() })
            .where(eq(feedPosts.id, postId))
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
    { preHandler },
    async (request, reply) => {
      try {
        await db.transaction(async tx => {
          const { spaceId, postId } = await authoredPost(tx, request)
          await tx.delete(feedPosts).where(eq(feedPosts.id, postId))
          await tx
            .delete(feedItemReactions)
            .where(eq(feedItemReactions.itemId, postId))
          await tellFeed(tx, spaceId, postId, 'removed')
        })
        return await reply.code(204).send()
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
