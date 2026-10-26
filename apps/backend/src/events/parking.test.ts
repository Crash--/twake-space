import { sql } from 'drizzle-orm'
import { pino } from 'pino'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { createTestDb, type TestDb } from '../infra/testing.ts'
import { postgresDeduplicator } from './dedupe.ts'
import type { PlatformEvent } from './envelope.ts'
import {
  parkIn,
  retryParked,
  retryParkedInTurn,
  scheduleParkedRetries
} from './parking.ts'
import {
  createMessageHandler,
  NotYetKnownError,
  type DeadLetter,
  type Handler
} from './router.ts'
import { parkedEvents } from './schema.ts'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
beforeEach(async () => {
  await testDb.db.delete(parkedEvents)
})

const log = pino({ level: 'silent' })

let next = 0
function memberAdded() {
  next += 1
  return {
    exchange: 'space',
    routingKey: 'twake.space.member.added',
    messageId: `msg-${String(next)}`,
    body: { spaceId: 'space-1' }
  }
}

function setup() {
  const handler = vi
    .fn<Handler<PlatformEvent>>()
    .mockRejectedValue(new NotYetKnownError('unknown space space-1'))
  const deadLetter = vi.fn<DeadLetter>().mockResolvedValue()
  const handle = createMessageHandler({
    routes: {
      activity: new Map(),
      platform: new Map([['twake.space.member.added', handler]])
    },
    dedupe: postgresDeduplicator(testDb.db, 'twake-space'),
    park: parkIn(testDb.db),
    logger: log
  })
  const retry = () => retryParked(testDb.db, handle, deadLetter, log)
  return { handler, deadLetter, handle, retry }
}

const parked = () =>
  testDb.db.select({ id: parkedEvents.id }).from(parkedEvents)

describe('parked events', () => {
  it('handles a parked event once the copy holds what it waited for', async () => {
    const { handler, handle, retry } = setup()
    const message = memberAdded()

    expect(await handle(message)).toBe('parked')
    expect(await parked()).toEqual([{ id: message.messageId }])

    handler.mockResolvedValueOnce()
    await retry()

    expect(handler).toHaveBeenLastCalledWith(
      {
        routingKey: 'twake.space.member.added',
        messageId: message.messageId,
        body: { spaceId: 'space-1' }
      },
      expect.anything(),
      expect.anything()
    )
    expect(await parked()).toEqual([])
  })

  it('keeps an event that still waits, or whose retry fails', async () => {
    const { handler, deadLetter, handle, retry } = setup()
    await handle(memberAdded())

    await retry()
    handler.mockRejectedValueOnce(new Error('db down'))
    await retry()

    expect(await parked()).toHaveLength(1)
    expect(deadLetter).not.toHaveBeenCalled()
  })

  it('keeps waiting for an event parked for 10 minutes', async () => {
    const { deadLetter, handle, retry } = setup()
    await handle(memberAdded())
    await testDb.db.execute(
      sql`update parked_events set parked_at = now() - interval '10 minutes'`
    )

    await retry()

    expect(deadLetter).not.toHaveBeenCalled()
    expect(await parked()).toHaveLength(1)
  })

  it('sends an event parked for over 30 minutes to the dead letter queue', async () => {
    const { deadLetter, handle, retry } = setup()
    const message = memberAdded()
    await handle(message)
    await testDb.db.execute(
      sql`update parked_events set parked_at = now() - interval '31 minutes'`
    )

    await retry()

    expect(deadLetter).toHaveBeenCalledWith(message, 'unknown space space-1')
    expect(await parked()).toEqual([])
  })

  it('keeps an expired event the dead letter queue refuses, and goes on', async () => {
    const { deadLetter, handle, retry } = setup()
    await handle(memberAdded())
    await handle(memberAdded())
    await testDb.db.execute(
      sql`update parked_events set parked_at = now() - interval '31 minutes'`
    )
    const brokerDown = new Error('broker down')
    deadLetter.mockRejectedValueOnce(brokerDown)

    const undelivered = await retry()

    expect(undelivered).toEqual([brokerDown])
    expect(deadLetter).toHaveBeenCalledTimes(2)
    expect(await parked()).toHaveLength(1)
  })

  it('leaves the pass to the replica that holds the turn', async () => {
    const { handle, deadLetter } = setup()
    await handle(memberAdded())
    let release: () => void = () => undefined
    let held: () => void = () => undefined
    const holding = new Promise<void>(resolve => {
      held = resolve
    })
    const other = testDb.db.transaction(async tx => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('parked_events'))`
      )
      held()
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    await holding

    const outcome = await retryParkedInTurn(testDb.db, handle, deadLetter, log)

    release()
    await other
    expect(outcome).toBeUndefined()
    expect(await parked()).toHaveLength(1)
  })

  it('stops only once the running pass has finished', async () => {
    const { handler, handle, deadLetter } = setup()
    await handle(memberAdded())
    let finish: () => void = () => undefined
    let started: () => void = () => undefined
    const running = new Promise<void>(resolve => {
      started = resolve
    })
    handler.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          started()
          finish = resolve
        })
    )
    const stop = scheduleParkedRetries(testDb.db, handle, deadLetter, log)
    await running

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stopped).toBe(false)

    finish()
    await stopping
    expect(await parked()).toEqual([])
  })
})
