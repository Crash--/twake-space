import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { configureHomeserver } from './homeservers.ts'
import { homeservers, organizations } from './schema.ts'

const homeserver = {
  url: 'https://matrix.example.com',
  serverName: 'example.com'
}

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
beforeEach(async () => {
  await testDb.db.delete(organizations)
  await testDb.db.delete(homeservers)
})

describe('configureHomeserver', () => {
  it('stores the homeserver', async () => {
    await configureHomeserver(testDb.db, homeserver)

    expect(await testDb.db.select().from(homeservers)).toEqual([
      expect.objectContaining({
        url: 'https://matrix.example.com',
        serverName: 'example.com',
        chatUrl: null
      })
    ])
  })

  it('points every organization to it, with chat', async () => {
    await testDb.db.insert(organizations).values([
      { organizationId: 'linagora', domain: 'linagora.com' },
      { organizationId: 'acme', domain: 'acme.com', chatAvailable: false }
    ])

    const id = await configureHomeserver(testDb.db, homeserver)

    expect(
      await testDb.db
        .select({
          homeserverId: organizations.homeserverId,
          chat: organizations.chatAvailable
        })
        .from(organizations)
    ).toEqual([
      { homeserverId: id, chat: true },
      { homeserverId: id, chat: true }
    ])
  })

  it('updates the same homeserver when its configuration changes', async () => {
    const first = await configureHomeserver(testDb.db, homeserver)

    const second = await configureHomeserver(testDb.db, {
      ...homeserver,
      serverName: 'renamed.example.com'
    })

    expect(second).toBe(first)
    const rows = await testDb.db.select().from(homeservers)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.serverName).toBe('renamed.example.com')
  })
})
