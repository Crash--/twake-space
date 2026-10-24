import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db, Tx } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import { perMinute, type Authorize, type Limiter } from '../auth/index.ts'
import type { Caller } from '../auth/routes.ts'
import { notifications } from '../notifications/schema.ts'
import { reachableSpaces } from '../spaces/routes.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { apiTokens } from '../tokens/schema.ts'
import {
  DECISIONS,
  decodeCursor,
  findItem,
  listItems,
  orderOf,
  pinnedItems,
  type Cursor,
  type FeedItem
} from './items.ts'
import { tellFeed } from './live.ts'
import { askApprovers, forgetMentions, mentionMembers } from './mentions.ts'
import {
  activityEvents,
  feedCards,
  feedCategory,
  feedItemReactions,
  feedPollVotes,
  feedPostKind,
  feedPosts,
  feedReads
} from './schema.ts'

type PostKind = (typeof feedPostKind.enumValues)[number]

const CLOSING: PostKind[] = ['poll', 'yes_no', 'approval', 'feedback']

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
const newPostBody = postBody
  .extend({
    poll: z
      .union([
        z.object({
          kind: z.literal('choice').default('choice'),
          options: z
            .array(z.string().trim().min(1).max(200))
            .min(2)
            .max(10)
            .refine(
              options =>
                new Set(options.map(o => o.toLowerCase())).size ===
                options.length
            )
        }),
        z.strictObject({ kind: z.literal('yes_no') })
      ])
      .optional(),
    approval: z
      .object({
        approvers: z
          .array(z.uuid())
          .min(1)
          .max(20)
          .refine(ids => new Set(ids).size === ids.length)
      })
      .optional(),
    announcement: z.literal(true).optional(),
    feedback: z.literal(true).optional()
  })
  .refine(
    ({ poll, approval, announcement, feedback }) =>
      [poll, approval, announcement, feedback].filter(Boolean).length <= 1
  )
const voteBody = z.object({ option: z.int().min(0) })
const answerBody = z.object({ text: z.string().trim().min(1).max(2000) })
const decisionBody = z.object({
  decision: z.enum(DECISIONS),
  comment: z.string().trim().max(1000).optional()
})
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

// A token reads for its account, but the feedback answers go to the person.
const readBy = (caller: Caller) => (item: FeedItem) =>
  caller.kind === 'token' && item.kind === 'post' && item.feedback
    ? serialize({ ...item, feedback: { ...item.feedback, answers: null } })
    : serialize(item)

const serialize = (item: FeedItem) => ({
  ...item,
  time: item.time.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  ...(item.kind === 'post' && {
    editedAt: item.editedAt?.toISOString() ?? null,
    poll: item.poll && {
      ...item.poll,
      closedAt: item.poll.closedAt?.toISOString() ?? null
    },
    approval: item.approval && {
      ...item.approval,
      approvers: item.approval.approvers.map(approver => ({
        ...approver,
        decidedAt: approver.decidedAt?.toISOString() ?? null
      })),
      closedAt: item.approval.closedAt?.toISOString() ?? null
    },
    announcement: item.announcement && {
      pinnedAt: item.announcement.pinnedAt?.toISOString() ?? null
    },
    feedback: item.feedback && {
      ...item.feedback,
      answers:
        item.feedback.answers?.map(answer => ({
          ...answer,
          answeredAt: answer.answeredAt.toISOString()
        })) ?? null,
      closedAt: item.feedback.closedAt?.toISOString() ?? null
    }
  })
})

export function registerFeedRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize; limiter: Limiter }
) {
  const { db, limiter } = deps
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

  // An author made a viewer since may still take their post down: delete,
  // close or unpin it, nothing that reaches the space further.
  async function authoredPost(
    tx: Tx,
    request: FastifyRequest,
    { takingDown = false } = {}
  ) {
    const { caller, space } = await reach(request)
    const spaceId = space.id
    const postId = itemOf(request)
    const [post] = await tx
      .select({
        authorId: feedPosts.authorId,
        authorTokenId: feedPosts.authorTokenId,
        tokenAccountId: apiTokens.accountId,
        kind: feedPosts.kind
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
    if (space.role === 'viewer' && !takingDown) {
      throw new Refusal(403, 'cannot_post')
    }
    return { spaceId, postId, caller, kind: post.kind }
  }

  // Shared: a vote waits for the poll's closing, and the closing for the vote.
  async function openPoll(
    tx: Tx,
    spaceId: string,
    postId: string,
    kinds: PostKind[] = ['poll', 'yes_no']
  ) {
    const [post] = await tx
      .select({
        kind: feedPosts.kind,
        authorId: feedPosts.authorId,
        options: feedPosts.pollOptions,
        approverIds: feedPosts.approverIds,
        closedAt: feedPosts.pollClosedAt
      })
      .from(feedPosts)
      .where(and(eq(feedPosts.id, postId), eq(feedPosts.spaceId, spaceId)))
      .for('share')
    if (!post || !kinds.includes(post.kind)) {
      throw new Refusal(404, 'not_found')
    }
    if (post.closedAt) throw new Refusal(409, 'poll_closed')
    return post
  }

  async function checkApprovers(
    tx: Tx,
    spaceId: string,
    authorId: string,
    approverIds: string[]
  ) {
    const members = await tx
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, spaceId),
          inArray(spaceMembers.userId, approverIds),
          ne(spaceMembers.userId, authorId)
        )
      )
    if (members.length < approverIds.length) {
      throw new Refusal(400, 'invalid_approvers')
    }
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
    // Paging, filters and search all read here, and a search scans every post.
    { preHandler: read, config: { limit: perMinute(120) } },
    async (request, reply) => {
      try {
        const { caller, space } = await reach(request)
        const { category, before, since, q, limit } = parse(
          feedQuery,
          request.query
        )
        const page = await listItems(db, space.id, {
          limit,
          viewer: caller.userId,
          ...(category && { category }),
          ...(before && { before }),
          ...(since && { since }),
          ...(q && { q })
        })
        return { items: page.items.map(readBy(caller)), next: page.next }
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
        const { caller, space } = await reach(request)
        const item = await findItem(
          db,
          space.id,
          itemOf(request),
          caller.userId
        )
        if (!item) throw new Refusal(404, 'not_found')
        return readBy(caller)(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.get(
    '/spaces/:spaceId/feed/pinned',
    { preHandler: read },
    async (request, reply) => {
      try {
        const { caller, space } = await reach(request)
        const items = await pinnedItems(db, space.id, caller.userId)
        return { items: items.map(readBy(caller)) }
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // A feed never opened has no mark, so nothing in it counts as new, as in
  // the feed itself; its mentions still do, an approval asked of the member
  // included. A mention older than the mark was seen in the feed, even though
  // its notification may stay unread.
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
          and ${notifications.type} in ('card_mention', 'approval_request')
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
    { preHandler: write, config: { limit: perMinute(10) } },
    async (request, reply) => {
      try {
        const { caller, space } = await reach(request)
        const spaceId = space.id
        if (space.role === 'viewer') throw new Refusal(403, 'cannot_post')
        const { body, poll, approval, announcement, feedback, mentions } =
          parse(newPostBody, request.body)
        const speaker = mentioner(caller, mentions)
        // The approvers hear from a person, as a mention does.
        if (approval && !speaker) {
          throw new Refusal(403, 'cannot_request_approval')
        }
        // The answers go to the person who asked, not to a token.
        if (feedback && caller.kind !== 'session') {
          throw new Refusal(403, 'cannot_ask_feedback')
        }
        const kind: PostKind = approval
          ? 'approval'
          : announcement
            ? 'announcement'
            : feedback
              ? 'feedback'
              : poll?.kind === 'yes_no'
                ? 'yes_no'
                : poll
                  ? 'poll'
                  : 'text'
        const time = new Date()
        const item = await db.transaction(async tx => {
          if (approval && speaker) {
            await checkApprovers(tx, spaceId, speaker, approval.approvers)
          }
          const [post] = await tx
            .insert(feedPosts)
            .values({
              spaceId,
              ...(caller.kind === 'token'
                ? { authorTokenId: caller.tokenId }
                : { authorId: caller.userId }),
              kind,
              body,
              time,
              pollOptions: poll?.kind === 'choice' ? poll.options : null,
              approverIds: approval?.approvers ?? null,
              pinnedAt: announcement ? time : null
            })
            .returning({ id: feedPosts.id })
          if (!post) throw new Error('the post insert returned no row')
          if (speaker) {
            const sent = { id: post.id, spaceId, authorId: speaker, body }
            // An approver hears once, of the request.
            await mentionMembers(
              tx,
              sent,
              mentions.filter(id => !approval?.approvers.includes(id)),
              limiter
            )
            if (approval) await askApprovers(tx, sent, approval.approvers)
          }
          await tellFeed(tx, spaceId, post.id, 'added')
          return findItem(tx, spaceId, post.id, caller.userId)
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
    { preHandler: write, config: { limit: perMinute(30) } },
    async (request, reply) => {
      try {
        const item = await db.transaction(async tx => {
          const { spaceId, postId, caller, kind } = await authoredPost(
            tx,
            request
          )
          // Decisions and answers reply to the text people read.
          if (kind === 'approval') {
            throw new Refusal(409, 'cannot_edit_approval')
          }
          if (kind === 'feedback') {
            throw new Refusal(409, 'cannot_edit_feedback')
          }
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
              mentions,
              limiter
            )
          }
          await tellFeed(tx, spaceId, postId, 'changed')
          return findItem(tx, spaceId, postId, caller.userId)
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
          const { spaceId, postId } = await authoredPost(tx, request, {
            takingDown: true
          })
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
    { preHandler, config: { limit: perMinute(30) } },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const postId = itemOf(request)
        const { option } = parse(voteBody, request.body)
        await db.transaction(async tx => {
          const poll = await openPoll(tx, spaceId, postId)
          if (option >= (poll.options?.length ?? 2)) {
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
    { preHandler, config: { limit: perMinute(30) } },
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
          const { spaceId, postId, caller } = await authoredPost(tx, request, {
            takingDown: true
          })
          const [closed] = await tx
            .update(feedPosts)
            .set({ pollClosedAt: new Date() })
            .where(
              and(
                eq(feedPosts.id, postId),
                inArray(feedPosts.kind, CLOSING),
                isNull(feedPosts.pollClosedAt)
              )
            )
            .returning({ id: feedPosts.id })
          if (closed) await tellFeed(tx, spaceId, postId, 'changed')
          return findItem(tx, spaceId, postId, caller.userId)
        })
        if (
          item?.kind !== 'post' ||
          (!item.poll && !item.approval && !item.feedback)
        ) {
          throw new Refusal(404, 'not_found')
        }
        return serialize(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // Pinning again keeps the announcement where it was.
  const pin =
    (pinned: boolean) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const item = await db.transaction(async tx => {
          const { spaceId, postId, caller, kind } = await authoredPost(
            tx,
            request,
            { takingDown: !pinned }
          )
          if (kind !== 'announcement') throw new Refusal(404, 'not_found')
          const [moved] = await tx
            .update(feedPosts)
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(feedPosts.id, postId),
                pinned
                  ? isNull(feedPosts.pinnedAt)
                  : isNotNull(feedPosts.pinnedAt)
              )
            )
            .returning({ id: feedPosts.id })
          if (moved) await tellFeed(tx, spaceId, postId, 'changed')
          return findItem(tx, spaceId, postId, caller.userId)
        })
        if (!item) throw new Error('the pinned post is not found')
        return serialize(item)
      } catch (error) {
        return refused(error, reply)
      }
    }
  const pinUrl = '/spaces/:spaceId/feed/posts/:itemId/pin'
  app.put(pinUrl, { preHandler: write }, pin(true))
  app.delete(pinUrl, { preHandler: write }, pin(false))

  // Answering again replaces the answer.
  app.put(
    '/spaces/:spaceId/feed/posts/:itemId/answer',
    { preHandler, config: { limit: perMinute(30) } },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const postId = itemOf(request)
        const { text } = parse(answerBody, request.body)
        await db.transaction(async tx => {
          const post = await openPoll(tx, spaceId, postId, ['feedback'])
          if (post.authorId === userId) {
            throw new Refusal(403, 'cannot_answer_own')
          }
          const [answered] = await tx
            .insert(feedPollVotes)
            .values({ postId, userId, option: 0, comment: text })
            .onConflictDoUpdate({
              target: [feedPollVotes.postId, feedPollVotes.userId],
              set: { comment: text, createdAt: new Date() },
              setWhere: ne(feedPollVotes.comment, text)
            })
            .returning({ postId: feedPollVotes.postId })
          if (answered) await tellFeed(tx, spaceId, postId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  // An approver decides once.
  app.put(
    '/spaces/:spaceId/feed/posts/:itemId/decision',
    { preHandler, config: { limit: perMinute(30) } },
    async (request, reply) => {
      try {
        const { spaceId, userId } = await memberOf(request)
        const postId = itemOf(request)
        const { decision, comment } = parse(decisionBody, request.body)
        await db.transaction(async tx => {
          const post = await openPoll(tx, spaceId, postId, ['approval'])
          if (!post.approverIds?.includes(userId)) {
            throw new Refusal(403, 'not_approver')
          }
          const [decided] = await tx
            .insert(feedPollVotes)
            .values({
              postId,
              userId,
              option: DECISIONS.indexOf(decision),
              comment: comment || null
            })
            .onConflictDoNothing()
            .returning({ postId: feedPollVotes.postId })
          if (!decided) throw new Refusal(409, 'already_decided')
          await tellFeed(tx, spaceId, postId, 'changed')
        })
        return await reply.code(204).send()
      } catch (error) {
        return refused(error, reply)
      }
    }
  )

  app.put(
    '/spaces/:spaceId/feed/items/:itemId/reactions/:key',
    { preHandler, config: { limit: perMinute(60) } },
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
    { preHandler, config: { limit: perMinute(60) } },
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
