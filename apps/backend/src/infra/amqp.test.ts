import { EventEmitter } from 'node:events'
import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client'
import type amqplib from 'amqplib'
import { pino } from 'pino'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from 'vitest'
import type { IncomingMessage, Outcome } from '../events/router.ts'
import { amqpTopology } from '../events/topology.ts'
import {
  activitySubscription,
  canonical,
  consumerAlive,
  consumerStats,
  deadLetterQueue,
  deliveryHandler,
  subscription,
  sweepPublisher
} from './amqp.ts'

const properties = (
  overrides: Partial<RabbitMQMessageProperties> = {}
): RabbitMQMessageProperties => ({
  exchange: 'b2b',
  routingKey: 'b2b.group.updated',
  messageId: 'm-1',
  headers: {},
  ...overrides
})

function setup(handle: (message: IncomingMessage) => Promise<Outcome>) {
  const lines: { level: number; msg: string }[] = []
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as { level: number; msg: string })
      }
    }
  )
  const stats = consumerStats()
  const deliver = deliveryHandler(vi.fn(handle), stats, logger)
  return { deliver, stats, lines }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('deliveryHandler', () => {
  it('hands the delivery to the router and counts its outcome', async () => {
    const handle = vi.fn(() => Promise.resolve<Outcome>('processed'))
    const stats = consumerStats()
    const deliver = deliveryHandler(handle, stats, pino({ level: 'silent' }))

    await deliver({ groupId: 'g1' }, properties())

    expect(handle).toHaveBeenCalledWith({
      exchange: 'b2b',
      routingKey: 'b2b.group.updated',
      messageId: 'm-1',
      body: { groupId: 'g1' }
    })
    expect(stats.outcomes).toEqual(new Map([['processed', 1]]))
  })

  it('dead-letters an event the router rejects', async () => {
    const { deliver } = setup(() => Promise.resolve('rejected'))

    await expect(deliver({}, properties())).rejects.toMatchObject({
      name: 'DeadLetterError'
    })
  })

  it('fails so the message is retried, and counts the failure', async () => {
    const { deliver, stats } = setup(() => Promise.reject(new Error('db down')))

    await expect(deliver({}, properties())).rejects.toThrow('db down')
    expect(stats.outcomes).toEqual(new Map([['failed', 1]]))
  })

  it('warns once when a message has failed for over 25 minutes', async () => {
    let failing = true
    const { deliver, lines } = setup(() =>
      failing
        ? Promise.reject(new Error('db down'))
        : Promise.resolve('processed')
    )

    const message = properties()
    await deliver({}, message).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(24 * 60_000)
    await deliver({}, message).catch(() => undefined)
    expect(lines).toEqual([])

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await deliver({}, message).catch(() => undefined)
    await deliver({}, message).catch(() => undefined)
    expect(lines.map(line => line.msg)).toEqual([
      'a message has failed for over 25 minutes; the broker may redeliver it'
    ])

    failing = false
    await deliver({}, message)
    failing = true
    await deliver({}, message).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await deliver({}, message).catch(() => undefined)
    expect(lines).toHaveLength(1)
  })

  it('keeps the failure streak of a message while another one succeeds', async () => {
    const { deliver, lines } = setup(message =>
      message.messageId === 'm-1'
        ? Promise.reject(new Error('db down'))
        : Promise.resolve('processed')
    )
    const failingOne = properties()

    await deliver({}, failingOne).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await deliver({}, properties({ messageId: 'm-2' }))
    await deliver({}, failingOne).catch(() => undefined)

    expect(lines).toHaveLength(1)
  })
})

describe('consumerAlive', () => {
  const connected = [{ isConnected: () => true }]

  it('stays alive while idle, and while a handler runs under 5 minutes', async () => {
    let finish: () => void = () => undefined
    const { deliver, stats } = setup(
      () =>
        new Promise(resolve => {
          finish = () => {
            resolve('processed')
          }
        })
    )
    const alive = consumerAlive(connected, stats)
    expect(alive()).toBe(true)

    const delivered = deliver({}, properties())
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(alive()).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(alive()).toBe(false)

    finish()
    await delivered
    expect(alive()).toBe(true)
  })

  it('times each message in flight on its own', async () => {
    const finish: (() => void)[] = []
    const { deliver, stats } = setup(
      () =>
        new Promise(resolve => {
          finish.push(() => {
            resolve('processed')
          })
        })
    )
    const alive = consumerAlive(connected, stats)

    const first = deliver({}, properties())
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    const second = deliver({}, properties({ messageId: 'm-2' }))
    finish[0]?.()
    await first
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(alive()).toBe(true)

    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(alive()).toBe(false)

    finish[1]?.()
    await second
    expect(alive()).toBe(true)
  })

  it('rides out a reconnect, and is dead once a client is disconnected for a minute', async () => {
    let connectedNow = false
    const alive = consumerAlive(
      [{ isConnected: () => true }, { isConnected: () => connectedNow }],
      consumerStats()
    )

    expect(alive()).toBe(true)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(alive()).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(alive()).toBe(false)

    connectedNow = true
    expect(alive()).toBe(true)
    connectedNow = false
    expect(alive()).toBe(true)
  })

  it('is dead while a reconnect has failed to restore a subscription', () => {
    const stats = consumerStats()
    const alive = consumerAlive(connected, stats)

    stats.reconnected('twake-space', { subscriptionsFailed: 0 })
    expect(alive()).toBe(true)

    stats.reconnected('twake-space.activity', { subscriptionsFailed: 1 })
    stats.reconnected('twake-space', { subscriptionsFailed: 0 })
    expect(alive()).toBe(false)

    stats.reconnected('twake-space.activity', { subscriptionsFailed: 0 })
    expect(alive()).toBe(true)
  })
})

describe('subscription', () => {
  it('binds the queue to each event, and checks the exchanges others own', () => {
    const { exchange, routingKey, queue, options } = subscription(
      amqpTopology.parse({
        AMQP_EVENTS: '{"dns.validated":{"exchange":"dns"}}'
      }).amqp
    )

    expect({ exchange, routingKey, queue }).toEqual({
      exchange: 'space',
      routingKey: 'twake.space.created',
      queue: 'twake-space'
    })
    expect(options.bindings).toHaveLength(20)
    expect(options.bindings).toContainEqual({
      exchange: 'b2b',
      routingKey: 'chat.deployment.updated'
    })
    expect(options.bindings).toContainEqual({
      exchange: 'dns',
      routingKey: 'dns.validated'
    })
    expect(options.bindings).toContainEqual({
      exchange: 'activity',
      routingKey: 'com.twake.*.space.provisioned.v1'
    })
    expect(options.bindings).toContainEqual({
      exchange: 'activity',
      routingKey: 'com.twake.drive.org_drive.#'
    })
    expect(options.bindings).not.toContainEqual({
      exchange: 'activity',
      routingKey: '#'
    })
    // RabbitMQ topic matching: `*` takes one word, `#` any number.
    const matches = (pattern: string, key: string) =>
      new RegExp(
        `^${pattern
          .split('.')
          .map(w => (w === '#' ? '.*' : w === '*' ? '[^.]+' : w))
          .join('\\.')}$`
      ).test(key)
    const activityKeys = options.bindings
      .filter(b => b.exchange === 'activity')
      .map(b => b.routingKey)
    for (const type of [
      'com.twake.drive.org_drive.ready.v1',
      'com.twake.drive.org_drive.removed.v1',
      'com.twake.tasks.space.provisioned.v1'
    ]) {
      expect(activityKeys.some(k => matches(k, type))).toBe(true)
    }
    expect(options.passiveExchanges).toEqual(['space', 'b2b', 'dns'])
    expect(options.deadLetterExchange).toBe('twake-space.dlx')
    expect(options.queueArguments).toMatchObject({
      'x-single-active-consumer': true,
      'x-delivery-limit': 20
    })
  })
})

describe('activitySubscription', () => {
  it('binds every activity event to a queue every replica consumes, with its own dead letter exchange', () => {
    const { exchange, routingKey, queue, options } = activitySubscription(
      amqpTopology.parse({ AMQP_ACTIVITY_EXCHANGE: 'apps' }).amqp
    )

    expect({ exchange, routingKey, queue }).toEqual({
      exchange: 'apps',
      routingKey: '#',
      queue: 'twake-space.activity'
    })
    expect(options.deadLetterExchange).toBe('twake-space.activity.dlx')
    expect(options.queueArguments).toEqual({ 'x-delivery-limit': 20 })
  })
})

describe('canonical', () => {
  const topology = amqpTopology.parse({
    AMQP_ACTIVITY_EXCHANGE: 'apps',
    AMQP_EVENTS: '{"chat.deployment.completed":{"routingKey":"deployed"}}'
  }).amqp

  it('names a platform message after the event bound to its key', () => {
    expect(canonical(topology, 'b2b', 'deployed')).toEqual({
      exchange: 'b2b',
      routingKey: 'chat.deployment.completed'
    })
  })

  it('names the activity exchange activity, whatever it is called', () => {
    expect(canonical(topology, 'apps', 'com.twake.tasks.x')).toEqual({
      exchange: 'activity',
      routingKey: 'com.twake.tasks.x'
    })
  })

  it('keeps any other routing key as it came', () => {
    expect(canonical(topology, 'b2b', 'chat.deployment.completed')).toEqual({
      exchange: 'b2b',
      routingKey: 'chat.deployment.completed'
    })
  })
})

describe('deadLetterQueue', () => {
  it('publishes the event to the dead letter exchange, under the key that reaches the dead letter queue', async () => {
    const client = { publish: vi.fn(() => Promise.resolve()) }
    const topology = amqpTopology.parse({
      AMQP_DEAD_LETTER_EXCHANGE: 'spaces.dlx'
    }).amqp

    await deadLetterQueue(client, topology)(
      {
        exchange: 'space',
        routingKey: 'twake.space.member.added',
        messageId: 'm-1',
        body: { spaceId: 'space-1' }
      },
      'unknown space space-1'
    )

    expect(client.publish).toHaveBeenCalledWith(
      'spaces.dlx',
      'twake.space.created.dead',
      { spaceId: 'space-1' },
      {
        messageId: 'm-1',
        mandatory: true,
        headers: {
          'x-twake-space-exchange': 'space',
          'x-twake-space-routing-key': 'twake.space.member.added',
          'x-twake-space-reason': 'unknown space space-1'
        }
      }
    )
  })
})

function fakeBroker() {
  const state = {
    declarable: true,
    reachable: true,
    unroutable: false,
    confirming: true,
    answering: true
  }
  const channels: {
    assertExchange: Mock
    publish: Mock
  }[] = []
  const connections: (EventEmitter & { close: Mock })[] = []
  const connect = vi.fn(() => {
    if (!state.reachable) return Promise.reject(new Error('ECONNREFUSED'))
    const connection = Object.assign(new EventEmitter(), {
      close: vi.fn(() => Promise.resolve()),
      createConfirmChannel: () => {
        const channel = Object.assign(new EventEmitter(), {
          assertExchange: vi.fn(() =>
            !state.answering
              ? new Promise(() => undefined)
              : state.declarable
                ? Promise.resolve({})
                : Promise.reject(new Error('ACCESS_REFUSED - configure'))
          ),
          publish: vi.fn(() => {
            if (state.unroutable) channel.emit('return', {})
            return true
          }),
          waitForConfirms: () =>
            state.confirming
              ? Promise.resolve()
              : new Promise<void>(() => undefined)
        })
        channels.push(channel)
        return Promise.resolve(channel)
      }
    })
    connections.push(connection)
    return Promise.resolve(connection)
  })
  return {
    connect: connect as unknown as () => Promise<amqplib.ChannelModel>,
    connects: connect,
    channels,
    connections,
    state
  }
}

describe('sweepPublisher', () => {
  const KEY = 'drive.org_drive.ensure'

  it('declares the exchange and publishes the message mandatory', async () => {
    const broker = fakeBroker()
    const drives = sweepPublisher(broker.connect, 'drive', 1000)

    await drives.publish(KEY, { revision: 1 })
    await drives.publish(KEY, { revision: 2 })

    const [channel] = broker.channels
    expect(broker.connects).toHaveBeenCalledTimes(1)
    expect(channel?.assertExchange).toHaveBeenCalledWith('drive', 'topic', {
      durable: true
    })
    expect(channel?.publish).toHaveBeenLastCalledWith(
      'drive',
      'drive.org_drive.ensure',
      Buffer.from(JSON.stringify({ revision: 2 })),
      expect.objectContaining({ mandatory: true, persistent: true })
    )
  })

  it('fails while the broker refuses to declare the exchange, and declares it again on the next publish', async () => {
    const broker = fakeBroker()
    broker.state.declarable = false
    const drives = sweepPublisher(broker.connect, 'drive', 1000)

    await expect(drives.publish(KEY, { revision: 1 })).rejects.toThrow(
      'ACCESS_REFUSED'
    )
    expect(broker.connections[0]?.close).toHaveBeenCalled()

    broker.state.declarable = true
    await drives.publish(KEY, { revision: 1 })
    expect(broker.connects).toHaveBeenCalledTimes(2)
  })

  it('fails a command no queue takes', async () => {
    const broker = fakeBroker()
    broker.state.unroutable = true
    const drives = sweepPublisher(broker.connect, 'drive', 1000)

    await expect(drives.publish(KEY, { revision: 1 })).rejects.toThrow(
      'no queue is bound'
    )
  })

  it('fails at once while the broker is unreachable, and reconnects once it is back', async () => {
    const broker = fakeBroker()
    const drives = sweepPublisher(broker.connect, 'drive', 1000)
    await drives.publish(KEY, { revision: 1 })
    broker.state.reachable = false
    broker.connections[0]?.emit('close')

    await expect(drives.publish(KEY, { revision: 2 })).rejects.toThrow(
      'ECONNREFUSED'
    )

    broker.state.reachable = true
    await drives.publish(KEY, { revision: 2 })
    expect(broker.connects).toHaveBeenCalledTimes(3)
  })

  it('drops the connection when the broker does not confirm in time', async () => {
    const broker = fakeBroker()
    broker.state.confirming = false
    const drives = sweepPublisher(broker.connect, 'drive', 10)

    await expect(drives.publish(KEY, { revision: 1 })).rejects.toThrow(
      'did not confirm in time'
    )
    expect(broker.connections[0]?.close).toHaveBeenCalled()
  })

  it('fails in time when the broker stalls before the channel is ready', async () => {
    const broker = fakeBroker()
    broker.state.answering = false
    const drives = sweepPublisher(broker.connect, 'drive', 10)

    await expect(drives.publish(KEY, { revision: 1 })).rejects.toThrow(
      'did not confirm in time'
    )
    expect(broker.channels[0]?.publish).not.toHaveBeenCalled()
  })
})
