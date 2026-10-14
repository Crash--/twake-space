import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  beforeCommit,
  createDb,
  migrateDb,
  postgresRefusal,
  type Tx
} from './db.ts'
import { createTestDb, type TestDb } from './testing.ts'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb({ migrated: false })
})
afterAll(() => testDb.drop())

describe('migrateDb', () => {
  it('lets replicas starting together apply each migration once', async () => {
    const replicas = [1, 2, 3].map(() => createDb(testDb.url))
    try {
      await Promise.all(replicas.map(({ sql }) => migrateDb(sql)))

      const applied = await testDb.sql<{ n: number }[]>`
        select count(*)::int as n from drizzle.__drizzle_migrations`
      const folders = readdirSync(
        fileURLToPath(new URL('../../drizzle', import.meta.url)),
        { withFileTypes: true }
      ).filter(entry => entry.isDirectory())
      expect(applied[0]?.n).toBe(folders.length)
    } finally {
      await Promise.all(replicas.map(({ sql }) => sql.end()))
    }
  })
})

describe('beforeCommit', () => {
  const key = Symbol('items')
  const collect = (tx: Tx, item: string, steps: string[]) =>
    beforeCommit(
      tx,
      key,
      () => [] as string[],
      (_, items) => {
        steps.push(`finish ${items.join(',')}`)
        return Promise.resolve()
      }
    ).push(item)

  it('finishes once with what the body and its savepoints collected, after the body', async () => {
    const { sql, db } = createDb(testDb.url)
    const steps: string[] = []
    try {
      await db.transaction(async tx => {
        collect(tx, 'a', steps)
        await tx.transaction(savepoint => {
          collect(savepoint, 'b', steps)
          return Promise.resolve()
        })
        steps.push('body done')
      })
    } finally {
      await sql.end()
    }

    expect(steps).toEqual(['body done', 'finish a,b'])
  })

  it('rolls the transaction back when the finish fails', async () => {
    const { sql, db } = createDb(testDb.url)
    await sql`create table finished (item text)`
    try {
      await expect(
        db.transaction(async tx => {
          await tx.execute(`insert into finished values ('a')`)
          beforeCommit(
            tx,
            key,
            () => null,
            () => Promise.reject(new Error('refused'))
          )
        })
      ).rejects.toThrow('refused')

      expect(await sql`select * from finished`).toHaveLength(0)
    } finally {
      await sql.end()
    }
  })
})

describe('postgresRefusal', () => {
  it('refuses a key too long for its index, as it fails on every retry', async () => {
    await testDb.sql`create table keys (key text primary key)`
    const key = randomBytes(8000).toString('base64')

    const error: unknown = await testDb.sql`insert into keys values (${key})`
      .then(() => null)
      .catch((e: unknown) => e)

    expect(postgresRefusal(error)).toMatch(/^54000/)
  })
})
