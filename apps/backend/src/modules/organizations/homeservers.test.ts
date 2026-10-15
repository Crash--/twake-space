import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decrypt, hashSecret } from '../../infra/secrets.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { configureHomeserver } from './homeservers.ts'
import { homeservers, organizations } from './schema.ts'

const key = randomBytes(32)
const homeserver = {
  url: 'https://matrix.example.com',
  serverName: 'example.com',
  asToken: 'as-secret',
  hsToken: 'hs-secret'
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
  it('stores the tokens encrypted, with a hash of hs_token for lookup', async () => {
    await configureHomeserver(testDb.db, key, homeserver)

    const [row] = await testDb.db
      .select()
      .from(homeservers)
      .where(eq(homeservers.hsTokenHash, hashSecret('hs-secret')))
    expect(row).toMatchObject({
      url: 'https://matrix.example.com',
      serverName: 'example.com'
    })
    expect(row && decrypt(key, row.asToken)).toBe('as-secret')
    expect(row && decrypt(key, row.hsToken)).toBe('hs-secret')
    expect(row?.asToken.toString()).not.toContain('as-secret')
    expect(row?.chatUrl).toBeNull()
  })

  it('points every organization to it', async () => {
    await testDb.db.insert(organizations).values([
      { organizationId: 'linagora', domain: 'linagora.com' },
      { organizationId: 'acme', domain: 'acme.com' }
    ])

    const id = await configureHomeserver(testDb.db, key, homeserver)

    expect(
      await testDb.db
        .select({ homeserverId: organizations.homeserverId })
        .from(organizations)
    ).toEqual([{ homeserverId: id }, { homeserverId: id }])
  })

  it('updates the same homeserver when its configuration changes', async () => {
    const first = await configureHomeserver(testDb.db, key, homeserver)

    const second = await configureHomeserver(testDb.db, key, {
      ...homeserver,
      hsToken: 'rotated'
    })

    expect(second).toBe(first)
    const rows = await testDb.db.select().from(homeservers)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.hsTokenHash).toBe(hashSecret('rotated'))
  })

  it('takes a new server name with the same tokens', async () => {
    const first = await configureHomeserver(testDb.db, key, homeserver)

    const second = await configureHomeserver(testDb.db, key, {
      ...homeserver,
      serverName: 'renamed.example.com'
    })

    expect(second).toBe(first)
  })
})
