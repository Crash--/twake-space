import type { RabbitMQClient } from '@linagora/rabbitmq-client'
import { eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import { afterCommit, type Tx } from '../../infra/db.ts'
import { spaceMembers } from '../spaces/schema.ts'
import { LIVE_EVENTS, type LiveEvent, type Streams } from './streams.ts'

const UPDATE = 'live.update'
const REVOKED = 'session.revoked'

const update = z.object({
  event: z.enum(LIVE_EVENTS),
  users: z.array(z.string()),
  data: z.looseObject({})
})
const revoked = z.object({ sessionId: z.string() })

export type Broker = Pick<RabbitMQClient, 'publish' | 'subscribe'>

let publish: (
  routingKey: string,
  message: Record<string, unknown>
) => void = () => undefined

// After the commit, so a replica never sends a browser to read a change that is
// not there yet, or never will be.
function send(tx: Tx, routingKey: string, message: Record<string, unknown>) {
  afterCommit(tx, () => {
    publish(routingKey, message)
  })
}

export function tell(
  tx: Tx,
  event: LiveEvent,
  userIds: string[],
  data: object
): void {
  const users = [...new Set(userIds)]
  if (users.length > 0) send(tx, UPDATE, { event, users, data })
}

export async function tellSpaceMembers(
  tx: Tx,
  spaceId: string,
  event: LiveEvent = 'spaces',
  data: object = { spaceId }
) {
  const members = await tx
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
  tell(
    tx,
    event,
    members.map(m => m.userId),
    data
  )
}

export function tellRevoked(tx: Tx, sessionId: string): void {
  send(tx, REVOKED, { sessionId })
}

// Each replica gets its own queue, since each holds the streams of different
// people. An update lost while it is disconnected only costs a refresh: a
// browser reads everything again when its stream reopens. A lost revocation is
// caught by scheduleRevocationSweep.
export async function listenForLive(
  broker: Broker,
  exchange: string,
  streams: Pick<Streams, 'send' | 'closeSession'>,
  log: Pick<Logger, 'warn'>
): Promise<void> {
  await broker.subscribe(
    exchange,
    UPDATE,
    `${exchange}.replica`,
    (body, { routingKey }) => {
      if (routingKey === REVOKED) {
        const message = revoked.safeParse(body)
        if (message.success) streams.closeSession(message.data.sessionId)
        else log.warn({ routingKey }, 'a live message was not understood')
        return Promise.resolve()
      }
      const message = update.safeParse(body)
      if (!message.success) {
        log.warn({ routingKey }, 'a live message was not understood')
        return Promise.resolve()
      }
      const { event, users, data } = message.data
      for (const userId of users) streams.send(userId, event, data)
      return Promise.resolve()
    },
    {
      exclusive: true,
      bindings: [{ exchange, routingKey: REVOKED }],
      // A replica that falls behind drops the oldest rather than grow the queue.
      queueArguments: { 'x-max-length': 1000 }
    }
  )
  // A message is only worth something now, so it gets a single attempt. That
  // attempt is also what reconnects the client after a failed publish.
  publish = (routingKey, message) => {
    broker
      .publish(exchange, routingKey, message, { maxAttempts: 1 })
      .catch((error: unknown) => {
        log.warn({ err: error, routingKey }, 'a live message was not published')
      })
  }
}
