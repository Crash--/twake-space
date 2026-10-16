import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Authorize } from '../auth/index.ts'
import { activityEvents } from '../feed/schema.ts'
import { homeservers, organizations } from '../organizations/schema.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { enabledByDefault, notifyUsers } from './recipients.ts'
import {
  notifications,
  notificationSettings,
  notificationType
} from './schema.ts'

const PAGE = 50

// How Synapse's SSO mapping builds a person's Matrix localpart.
export type Localpart = 'uid' | 'email'

const listQuery = z.object({
  // The id of the last notification of the previous page.
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE)
})

const notificationParams = z.object({ id: z.uuid() })

const suggestionBody = z.object({
  matrixUserId: z.string().regex(/^@[^:]+:.+$/),
  externalId: z.string().min(1).max(128),
  text: z.string().min(1).max(500),
  pendingCallId: z.string().min(1).max(64),
  matrixRoomId: z.string().optional()
})

const settingsBody = z.partialRecord(
  z.enum(notificationType.enumValues),
  z.boolean()
)

function userOf(request: FastifyRequest): string {
  const caller = request.caller
  if (caller?.kind !== 'session') {
    throw new Error('authorize let a request through')
  }
  return caller.userId
}

export function registerNotificationRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize; localpart: Localpart }
) {
  const { db, localpart } = deps
  const preHandler = deps.authorize()

  // The member of the caller's organization behind a Matrix id: a space member
  // whose username or e-mail gives its localpart, on the organization's homeserver.
  async function userOfMatrixId(organizationId: string, matrixUserId: string) {
    const at = matrixUserId.indexOf(':')
    const name = matrixUserId.slice(1, at).toLowerCase()
    const members = await db
      .selectDistinct({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
      .innerJoin(
        organizations,
        eq(organizations.organizationId, spaces.organizationId)
      )
      .innerJoin(homeservers, eq(homeservers.id, organizations.homeserverId))
      .where(
        and(
          eq(spaces.organizationId, organizationId),
          eq(homeservers.serverName, matrixUserId.slice(at + 1)),
          localpart === 'uid'
            ? sql`lower(${spaceMembers.username}) = ${name}`
            : sql`lower(split_part(${spaceMembers.email}, '@', 1)) = ${name}`
        )
      )
      .limit(2)
    // Two members sharing a localpart (same e-mail name, other domains) is
    // no answer: the suggestion could reach the wrong one.
    return members.length === 1 ? members[0]?.userId : undefined
  }

  app.post(
    '/notifications/suggestions',
    { preHandler: deps.authorize('notifications:write') },
    async (request, reply) => {
      const caller = request.caller
      // authorize lets sessions in; only a technical account's token may push
      // suggestions, or a member could pose as a colleague's assistant.
      if (caller?.kind !== 'token' || !caller.technical) {
        return reply.code(403).send({ error: 'insufficient_scope' })
      }
      const body = suggestionBody.safeParse(request.body)
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: z.prettifyError(body.error)
        })
      }
      const { matrixUserId, externalId, ...payload } = body.data
      const userId = await userOfMatrixId(caller.organizationId, matrixUserId)
      if (!userId) return reply.code(404).send({ error: 'unknown_user' })
      const created = await db.transaction(async tx => {
        const [row] = await notifyUsers(
          tx,
          [{ userId, type: 'assistant_suggestion' }],
          { organizationId: caller.organizationId, spaceId: null, externalId },
          {
            text: payload.text,
            pendingCallId: payload.pendingCallId,
            matrixRoomId: payload.matrixRoomId ?? null
          }
        )
        return row
      })
      if (created) return reply.code(201).send({ id: created.id })
      // Already pushed, or the user turned these off (then there is no id).
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.externalId, externalId)
          )
        )
      return reply.send({ id: existing?.id ?? null })
    }
  )

  app.get('/notifications', { preHandler }, async (request, reply) => {
    const userId = userOf(request)
    const query = listQuery.safeParse(request.query)
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const { before, limit } = query.data
    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        spaceId: notifications.spaceId,
        payload: notifications.payload,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        activity: {
          type: activityEvents.type,
          category: activityEvents.category,
          actor: activityEvents.actor,
          content: activityEvents.content,
          time: activityEvents.time
        }
      })
      .from(notifications)
      .leftJoin(
        activityEvents,
        eq(activityEvents.id, notifications.activityEventId)
      )
      .where(
        and(
          eq(notifications.userId, userId),
          before === undefined
            ? undefined
            : sql`(${notifications.createdAt}, ${notifications.id}) < (
                select created_at, id from notifications
                where id = ${before} and user_id = ${userId}
              )`
        )
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
    const [unread] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt))
      )
    return {
      notifications: rows.map(({ readAt, ...row }) => ({
        ...row,
        read: readAt !== null
      })),
      unread: unread?.count ?? 0
    }
  })

  app.post('/notifications/read', { preHandler }, async (request, reply) => {
    await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.userId, userOf(request)),
          isNull(notifications.readAt)
        )
      )
    return reply.code(204).send()
  })

  app.post(
    '/notifications/:id/read',
    { preHandler },
    async (request, reply) => {
      const params = notificationParams.safeParse(request.params)
      if (!params.success) return reply.code(404).send({ error: 'not_found' })
      const [row] = await db
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(
          and(
            eq(notifications.id, params.data.id),
            eq(notifications.userId, userOf(request))
          )
        )
        .returning({ id: notifications.id })
      if (!row) return reply.code(404).send({ error: 'not_found' })
      return reply.code(204).send()
    }
  )

  app.get('/notifications/settings', { preHandler }, async request => {
    const choices = await db
      .select({
        type: notificationSettings.type,
        enabled: notificationSettings.enabled
      })
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, userOf(request)))
    const chosen = new Map(choices.map(c => [c.type, c.enabled]))
    return {
      settings: Object.fromEntries(
        notificationType.enumValues.map(type => [
          type,
          chosen.get(type) ?? enabledByDefault(type)
        ])
      )
    }
  })

  app.put('/notifications/settings', { preHandler }, async (request, reply) => {
    const body = settingsBody.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: z.prettifyError(body.error)
      })
    }
    const userId = userOf(request)
    const rows = Object.entries(body.data).map(([type, enabled]) => ({
      userId,
      type: type as (typeof notificationType.enumValues)[number],
      enabled
    }))
    if (rows.length > 0) {
      await db
        .insert(notificationSettings)
        .values(rows)
        .onConflictDoUpdate({
          target: [notificationSettings.userId, notificationSettings.type],
          set: { enabled: sql`excluded.enabled` }
        })
    }
    return reply.code(204).send()
  })
}
