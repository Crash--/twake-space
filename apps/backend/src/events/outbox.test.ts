import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../infra/testing.ts'
import { publishActivity, publishLater, type OutgoingEvent } from './outbox.ts'
import { outgoingActivity } from './schema.ts'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  await testDb.db.delete(outgoingActivity)
})

const anEvent = (type: string): OutgoingEvent => ({
  id: crypto.randomUUID(),
  type,
  data: {}
})

const store = (...events: OutgoingEvent[]) =>
  testDb.db.transaction(tx => publishLater(tx, events))

describe('publishActivity', () => {
  it('publishes the stored events in order, by their type, and forgets them', async () => {
    const first = anEvent('com.twake.space.first.v1')
    const second = anEvent('com.twake.space.second.v1')
    await store(first)
    await store(second)
    const published: [string, OutgoingEvent][] = []

    await publishActivity(testDb.db, (routingKey, event) => {
      published.push([routingKey, event])
      return Promise.resolve()
    })

    expect(published).toEqual([
      [first.type, first],
      [second.type, second]
    ])
    expect(await testDb.db.select().from(outgoingActivity)).toEqual([])
  })

  it('keeps an event the broker refuses, for the next pass', async () => {
    const event = anEvent('com.twake.space.first.v1')
    await store(event)

    await expect(
      publishActivity(testDb.db, () => Promise.reject(new Error('refused')))
    ).rejects.toThrow('refused')

    const kept = await testDb.db.select().from(outgoingActivity)
    expect(kept.map(row => row.event)).toEqual([event])
  })

  it('stores nothing when the transaction rolls back', async () => {
    await expect(
      testDb.db.transaction(async tx => {
        await publishLater(tx, [anEvent('com.twake.space.first.v1')])
        throw new Error('rolled back')
      })
    ).rejects.toThrow('rolled back')

    expect(await testDb.db.select().from(outgoingActivity)).toEqual([])
  })
})
