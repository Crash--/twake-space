import { setTimeout as delay } from 'node:timers/promises'
import {
  DeadLetterError,
  RabbitMQClient,
  type RabbitMQMessageHandler,
  type SubscribeOptions
} from '@linagora/rabbitmq-client'
import amqplib from 'amqplib'
import type { Logger } from 'pino'
import type { Config } from '../config.ts'
import { ACTIVITY_EXCHANGE } from '../events/envelope.ts'
import type { DeadLetter, IncomingMessage, Outcome } from '../events/router.ts'
import type { AmqpTopology } from '../events/topology.ts'

// The events whose order matters. Only what a handler exists for: a binding
// without one would only ack and drop. An app provisions on the space's created
// event, so its provisioned event comes here, after it. Drive replies come here
// too, so a reply and the space's deletion take turns.
export function subscription(topology: AmqpTopology) {
  const platform = Object.values(topology.events)
  const [primary, ...rest] = platform
  if (!primary) throw new Error('no platform event to bind')
  const options = {
    bindings: [
      ...rest,
      {
        exchange: topology.activityExchange,
        routingKey: topology.provisionedBinding
      },
      {
        exchange: topology.activityExchange,
        routingKey: topology.driveRepliesBinding
      }
    ],
    deadLetterExchange: topology.deadLetterExchange,
    // Other services own these. The apps and we declare the activity one, and
    // we declare the settings one so a platform without common settings runs.
    passiveExchanges: [...new Set(platform.map(b => b.exchange))].filter(
      exchange =>
        exchange !== topology.activityExchange &&
        exchange !== topology.events['user.settings.updated'].exchange
    ),
    maxRetries: Infinity,
    maxRetryDelay: MAX_RETRY_MS,
    queueArguments: {
      'x-single-active-consumer': true,
      // Failures retry in the process, so a redelivery means a crash or a
      // consumer_timeout: the default 20 rides out about 10 hours of outage.
      'x-delivery-limit': topology.deliveryLimit
    }
  } satisfies SubscribeOptions
  return { ...primary, queue: topology.queue, options }
}

// Each activity event stands alone, so every replica consumes the queue.
export function activitySubscription(topology: AmqpTopology) {
  const options = {
    deadLetterExchange: topology.activityDeadLetterExchange,
    maxRetries: Infinity,
    maxRetryDelay: MAX_RETRY_MS,
    queueArguments: { 'x-delivery-limit': topology.deliveryLimit }
  } satisfies SubscribeOptions
  return {
    exchange: topology.activityExchange,
    routingKey: '#',
    queue: topology.activityQueue,
    options
  }
}

// The router, its handlers and the parked rows know events by their default
// names, whatever a deployment calls the exchanges and keys.
export function canonical(
  topology: AmqpTopology,
  exchange: string,
  routingKey: string
): { exchange: string; routingKey: string } {
  if (exchange === topology.activityExchange) {
    return { exchange: ACTIVITY_EXCHANGE, routingKey }
  }
  const match = Object.entries(topology.events).find(
    ([, binding]) =>
      binding.exchange === exchange && binding.routingKey === routingKey
  )
  return { exchange, routingKey: match ? match[0] : routingKey }
}

const FIRST_RETRY_MS = 1000
const MAX_RETRY_MS = 60_000
const STUCK_MS = 5 * 60_000
// The client reconnects on its own; a broker restart should not restart pods.
const DISCONNECTED_MS = 60_000
// The broker's consumer_timeout (30 minutes by default) closes a channel that
// holds an unacked delivery for longer, which counts a redelivery.
const LONG_FAILING_MS = 25 * 60_000

type Handle = (message: IncomingMessage) => Promise<Outcome>

export type ConsumerStats = ReturnType<typeof consumerStats>

interface Handling {
  since: number
}

export function consumerStats() {
  const outcomes = new Map<Outcome | 'failed', number>()
  const handling = new Set<Handling>()
  const unsubscribed = new Set<string>()
  return {
    outcomes,
    started(): Handling {
      const started = { since: Date.now() }
      handling.add(started)
      return started
    },
    ended(started: Handling, outcome: Outcome | 'failed') {
      handling.delete(started)
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
    },
    // The client gives up on a subscription it fails to restore, and stays
    // connected without consuming.
    reconnected(
      queue: string,
      { subscriptionsFailed }: { subscriptionsFailed: number }
    ) {
      if (subscriptionsFailed > 0) unsubscribed.add(queue)
      else unsubscribed.delete(queue)
    },
    unsubscribed: () => unsubscribed.size > 0,
    stuck: () =>
      [...handling].some(({ since }) => Date.now() - since > STUCK_MS)
  }
}

// An idle consumer is alive: only a stuck handler, a lost connection or a lost
// subscription is not.
export function consumerAlive(
  clients: Pick<RabbitMQClient, 'isConnected'>[],
  stats: ConsumerStats
): () => boolean {
  const disconnectedSince = new Map<object, number>()
  return () => {
    const lost = clients.some(client => {
      if (client.isConnected()) {
        disconnectedSince.delete(client)
        return false
      }
      const since = disconnectedSince.get(client) ?? Date.now()
      disconnectedSince.set(client, since)
      return Date.now() - since > DISCONNECTED_MS
    })
    return !lost && !stats.stuck() && !stats.unsubscribed()
  }
}

// The client passes the same properties to every retry of a delivery, so they
// key its failure streak.
export function deliveryHandler(
  handle: Handle,
  stats: ConsumerStats,
  logger: Logger
): RabbitMQMessageHandler {
  const failing = new WeakMap<object, { since: number; warned: boolean }>()
  return async (body, properties) => {
    const { exchange, routingKey, messageId } = properties
    const started = stats.started()
    let outcome: Outcome
    try {
      outcome = await handle({
        exchange,
        routingKey,
        ...(messageId !== undefined && { messageId }),
        body
      })
    } catch (error) {
      stats.ended(started, 'failed')
      const streak = failing.get(properties) ?? {
        since: Date.now(),
        warned: false
      }
      failing.set(properties, streak)
      if (!streak.warned && Date.now() - streak.since > LONG_FAILING_MS) {
        streak.warned = true
        logger.error(
          { exchange, routingKey, messageId },
          'a message has failed for over 25 minutes; the broker may redeliver it'
        )
      }
      throw error
    }
    stats.ended(started, outcome)
    failing.delete(properties)
    if (outcome === 'rejected') {
      throw new DeadLetterError(`rejected ${routingKey}`)
    }
  }
}

// Through the queue's dead letter exchange and the key the client binds
// <queue>.dlq with: the default exchange is not ours to publish to.
export function deadLetterQueue(
  client: Pick<RabbitMQClient, 'publish'>,
  topology: AmqpTopology
): DeadLetter {
  const { routingKey } = subscription(topology)
  return (message, reason) =>
    client.publish(
      topology.deadLetterExchange,
      `${routingKey}.dead`,
      message.body as Record<string, unknown>,
      {
        ...(message.messageId !== undefined && {
          messageId: message.messageId
        }),
        // An unroutable publish then fails, which keeps the parked row.
        mandatory: true,
        headers: {
          'x-twake-space-exchange': message.exchange,
          'x-twake-space-routing-key': message.routingKey,
          'x-twake-space-reason': reason
        }
      }
    )
}

type Subscription = ReturnType<
  typeof subscription | typeof activitySubscription
>

// The prefetch is the channel's, so each queue has its own client.
async function connect(
  config: Config,
  logger: Logger,
  stats: ConsumerStats,
  queue: string,
  prefetch: number
): Promise<RabbitMQClient> {
  const client = new RabbitMQClient({
    url: config.AMQP_URL,
    prefetch,
    retryDelay: FIRST_RETRY_MS,
    // The client logs every message at info.
    logger: logger.child({ component: 'amqp', queue }, { level: 'warn' }),
    hooks: {
      onReconnect: info => {
        stats.reconnected(queue, info)
      }
    }
  })
  await client.init()
  return client
}

export interface DrivePublisher {
  publish: (command: Record<string, unknown>) => Promise<void>
  close: () => Promise<void>
}

// One attempt per publish and no reconnect loop: during an outage a sweep fails
// at once instead of queueing publishes for when the broker returns. Its own
// connection, as a refused publish closes the channel and must not stop a
// consumer.
export function drivePublisher(
  connect: () => Promise<amqplib.ChannelModel>,
  topology: Pick<AmqpTopology, 'driveExchange' | 'driveRoutingKey'>,
  timeoutMs: number
): DrivePublisher {
  const { driveExchange: exchange, driveRoutingKey: routingKey } = topology
  let open:
    | { connection: amqplib.ChannelModel; channel: amqplib.ConfirmChannel }
    | undefined
  const reset = () => {
    const connection = open?.connection
    open = undefined
    connection?.close().catch(() => undefined)
  }
  const opened = async () => {
    if (open) return open
    const connection = await connect()
    connection.on('error', () => undefined)
    connection.on('close', () => {
      if (open?.connection === connection) open = undefined
    })
    try {
      const channel = await connection.createConfirmChannel()
      channel.on('error', () => undefined)
      channel.on('close', () => {
        if (open?.channel === channel) reset()
      })
      await channel.assertExchange(exchange, 'topic', { durable: true })
      open = { connection, channel }
      return open
    } catch (error) {
      await connection.close().catch(() => undefined)
      throw error
    }
  }
  return {
    // The deadline also covers opening the channel: the caller holds the
    // command's row lock meanwhile, and amqplib's own timeout stops at the
    // handshake.
    async publish(command) {
      let returned = false as boolean
      let expired = false
      const send = async () => {
        const { channel } = await opened()
        if (expired) return
        const onReturn = () => {
          returned = true
        }
        channel.on('return', onReturn)
        try {
          channel.publish(
            exchange,
            routingKey,
            Buffer.from(JSON.stringify(command)),
            {
              persistent: true,
              mandatory: true,
              contentType: 'application/json'
            }
          )
          await channel.waitForConfirms()
        } finally {
          channel.off('return', onReturn)
        }
      }
      try {
        await Promise.race([
          send(),
          delay(timeoutMs, undefined, { ref: false }).then(() => {
            expired = true
            throw new Error('RabbitMQ did not confirm in time')
          })
        ])
      } catch (error) {
        reset()
        throw error
      }
      // RabbitMQ returns an unroutable message before it confirms it.
      if (returned) {
        throw new Error(`no queue is bound to ${exchange}/${routingKey}`)
      }
    },
    async close() {
      const connection = open?.connection
      open = undefined
      await connection?.close()
    }
  }
}

async function consume(
  client: RabbitMQClient,
  config: Config,
  logger: Logger,
  stats: ConsumerStats,
  { exchange, routingKey, queue, options }: Subscription,
  handle: Handle
) {
  await client.subscribe(
    exchange,
    routingKey,
    queue,
    deliveryHandler(
      message =>
        handle({
          ...message,
          ...canonical(config.amqp, message.exchange, message.routingKey)
        }),
      stats,
      logger
    ),
    options
  )
  logger.info({ queue }, 'consuming from RabbitMQ')
}

// Older versions bound every activity event to the space queue, and the client
// never removes a binding. Removing one already gone does nothing. To drop once
// every deployment has run it.
async function unbindOldActivity(url: string, topology: AmqpTopology) {
  const connection = await amqplib.connect(url)
  try {
    const channel = await connection.createChannel()
    await channel.unbindQueue(topology.queue, topology.activityExchange, '#')
  } finally {
    await connection.close()
  }
}

// The activity queue first, so it holds every activity event before the space
// queue lets them go.
export async function startConsumers(
  config: Config,
  logger: Logger,
  handle: { space: Handle; activity: Handle },
  stats: ConsumerStats,
  beforeConsuming: (client: RabbitMQClient) => Promise<void>
): Promise<{ space: RabbitMQClient; activity: RabbitMQClient }> {
  const { amqp } = config
  // One message at a time keeps the order the publishers sent.
  const space = await connect(config, logger, stats, amqp.queue, 1)
  await beforeConsuming(space)
  const activity = await connect(
    config,
    logger,
    stats,
    amqp.activityQueue,
    amqp.activityConcurrency
  )
  const subscribed = activitySubscription(amqp)
  await consume(activity, config, logger, stats, subscribed, handle.activity)
  await consume(space, config, logger, stats, subscription(amqp), handle.space)
  await unbindOldActivity(config.AMQP_URL, amqp)
  return { space, activity }
}
