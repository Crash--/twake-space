import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { notifications } from '../notifications/schema.ts'
import { purgeExpired } from './retention.ts'
import { activityEvents, feedItemReactions, feedPosts } from './schema.ts'

const NOW = new Date('2026-10-05T12:00:00Z')
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
beforeEach(async () => {
  const { db } = testDb
  await db.delete(activityEvents)
  await db.delete(notifications)
  await db.delete(feedPosts)
  await db.delete(feedItemReactions)
})

const SPACE = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'

async function seed(createdAt: Date, n: string) {
  const { db } = testDb
  const [event] = await db
    .insert(activityEvents)
    .values({
      source: 'twake://drive',
      eventId: `e${n}`,
      type: 'com.twake.drive.file.created.v1',
      category: 'files',
      objectType: 'file',
      objectId: 'f1',
      content: {},
      time: createdAt,
      createdAt
    })
    .returning()
  await db.insert(notifications).values({
    userId: '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e',
    type: 'card_mention',
    activityEventId: event?.id,
    payload: {},
    createdAt
  })
}

const counts = async () => {
  const { db } = testDb
  return {
    events: await db.$count(activityEvents),
    notifications: await db.$count(notifications)
  }
}

describe('purgeExpired', () => {
  it('deletes feed data past 12 months and notifications past 90 days', async () => {
    await seed(daysAgo(400), '1')
    await seed(daysAgo(100), '2')
    await seed(daysAgo(10), '3')

    expect(await purgeExpired(testDb.db, NOW)).toBe(true)

    expect(await counts()).toEqual({ events: 2, notifications: 1 })
  })

  it('deletes posts and reactions past 12 months, and reactions whose item is gone', async () => {
    const { db } = testDb
    const [old, recent] = await db
      .insert(feedPosts)
      .values([
        { spaceId: SPACE, authorId: ALICE, body: 'old', time: daysAgo(400) },
        { spaceId: SPACE, authorId: ALICE, body: 'new', time: daysAgo(10) }
      ])
      .returning({ id: feedPosts.id })
    if (!old || !recent) throw new Error('no posts')
    await db.insert(feedItemReactions).values([
      { itemId: recent.id, spaceId: SPACE, userId: ALICE, key: 'a' },
      {
        itemId: recent.id,
        spaceId: SPACE,
        userId: ALICE,
        key: 'b',
        createdAt: daysAgo(400)
      },
      { itemId: old.id, spaceId: SPACE, userId: ALICE, key: 'c' }
    ])

    await purgeExpired(db, NOW)

    expect(await db.select({ body: feedPosts.body }).from(feedPosts)).toEqual([
      { body: 'new' }
    ])
    expect(
      await db.select({ key: feedItemReactions.key }).from(feedItemReactions)
    ).toEqual([{ key: 'a' }])
  })

  it('leaves the purge to the replica already running it', async () => {
    await seed(daysAgo(400), '1')
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let locked = () => {}
    const lockTaken = new Promise<void>(resolve => {
      locked = resolve
    })
    const other = testDb.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('purge'))`)
      locked()
      await held
    })
    await lockTaken

    expect(await purgeExpired(testDb.db, NOW)).toBe(false)
    expect((await counts()).events).toBe(1)

    release()
    await other
  })
})
