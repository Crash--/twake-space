import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import { perHour, type Authorize } from '../auth/index.ts'
import { reachableSpaces } from '../spaces/routes.ts'
import { spaceResources } from '../spaces/schema.ts'

export const MEETING_REQUESTED = 'com.twake.space.meeting.requested.v1'

const MAX_DURATION_MS = 24 * 60 * 60 * 1000

const spaceParams = z.object({ spaceId: z.uuid() })

// Intl also takes offsets such as +02:00 and any case; the calendar gets the
// canonical IANA name.
const ianaZone = (zone: string) => {
  try {
    const { timeZone } = new Intl.DateTimeFormat('en', {
      timeZone: zone
    }).resolvedOptions()
    return /^[+-]/.test(timeZone) ? undefined : timeZone
  } catch {
    return undefined
  }
}

const meetingBody = z
  .object({
    // Given again by a retry, so the calendar creates one meeting.
    uid: z.uuid().optional(),
    title: z.string().trim().min(1).max(255),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timezone: z.string().transform((zone, ctx) => {
      const name = ianaZone(zone)
      if (!name) ctx.addIssue({ code: 'custom', message: 'not a time zone' })
      return name ?? z.NEVER
    }),
    description: z.string().trim().max(4000).optional()
  })
  .refine(({ start, end }) => {
    const duration = Date.parse(end) - Date.parse(start)
    return duration > 0 && duration <= MAX_DURATION_MS
  })

export type Publish = (
  routingKey: string,
  event: Record<string, unknown>,
  messageId: string
) => Promise<void>

export function registerMeetingRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize; publish: Publish }
) {
  const { db } = deps

  app.post(
    '/spaces/:spaceId/meetings',
    { preHandler: deps.authorize(), config: { limit: perHour(30) } },
    async (request, reply) => {
      const caller = request.caller
      if (caller?.kind !== 'session') {
        throw new Error('authorize let a request through')
      }
      const params = spaceParams.safeParse(request.params)
      if (!params.success) return reply.code(404).send({ error: 'not_found' })
      const [space] = await reachableSpaces(db, caller, params.data.spaceId)
      if (!space) return reply.code(404).send({ error: 'not_found' })
      // Viewers only read the team calendar.
      if (space.role === 'viewer') {
        return reply.code(403).send({ error: 'cannot_schedule' })
      }
      const body = meetingBody.safeParse(request.body)
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const [calendar] = await db
        .select({ id: spaceResources.resourceId })
        .from(spaceResources)
        .where(
          and(
            eq(spaceResources.spaceId, space.id),
            eq(spaceResources.kind, 'calendar')
          )
        )
      if (!calendar) return reply.code(409).send({ error: 'no_calendar' })

      const {
        uid = randomUUID(),
        title,
        start,
        end,
        timezone,
        description
      } = body.data
      const id = randomUUID()
      try {
        await deps.publish(
          MEETING_REQUESTED,
          {
            specversion: '1.0',
            id,
            source: 'twake://space',
            type: MEETING_REQUESTED,
            time: new Date().toISOString(),
            twakeorg: caller.organizationId,
            twakeactorid: caller.userId,
            twakeactor: caller.email,
            data: {
              uid,
              container: { kind: 'calendar', id: calendar.id },
              title,
              start,
              end,
              timezone,
              ...(description && { description })
            }
          },
          id
        )
      } catch (error) {
        request.log.error({ err: error }, 'meeting request not published')
        return reply.code(503).send({ error: 'unavailable' })
      }
      return reply.code(202).send({ uid })
    }
  )
}
