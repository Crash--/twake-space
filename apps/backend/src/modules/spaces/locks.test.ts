import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from '../../infra/db.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { lockOrganization, lockSpace } from './locks.ts'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb({ migrated: false })
})
afterAll(() => testDb.drop())

const SPACE = '6f1c2a3e-0000-4000-8000-000000000001'
const OTHER = '6f1c2a3e-0000-4000-8000-000000000002'

type Take = (tx: Tx) => Promise<void>

// The first transaction holds its lock a while; the second starts meanwhile.
async function race(first: Take, second: Take) {
  const order: string[] = []
  await Promise.all([
    testDb.db.transaction(async tx => {
      await first(tx)
      order.push('first in')
      await delay(100)
      order.push('first out')
    }),
    delay(20).then(() =>
      testDb.db.transaction(async tx => {
        await second(tx)
        order.push('second in')
      })
    )
  ])
  return order
}

describe('space locks', () => {
  it('make the events of one space take turns', async () => {
    const order = await race(
      tx => lockSpace(tx, 'org', SPACE),
      tx => lockSpace(tx, 'org', SPACE)
    )

    expect(order).toEqual(['first in', 'first out', 'second in'])
  })

  it('let the events of another space go on', async () => {
    const order = await race(
      tx => lockSpace(tx, 'org', SPACE),
      tx => lockSpace(tx, 'org', OTHER)
    )

    expect(order).toEqual(['first in', 'second in', 'first out'])
  })

  it('make an organization deletion wait for the events of its spaces', async () => {
    const order = await race(
      tx => lockSpace(tx, 'org', SPACE),
      tx => lockOrganization(tx, 'org', 'exclusive')
    )

    expect(order).toEqual(['first in', 'first out', 'second in'])
  })

  it('make the events of its spaces wait for an organization deletion', async () => {
    const order = await race(
      tx => lockOrganization(tx, 'org', 'exclusive'),
      tx => lockSpace(tx, 'org', SPACE)
    )

    expect(order).toEqual(['first in', 'first out', 'second in'])
  })
})
