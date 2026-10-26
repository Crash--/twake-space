import { asc, eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lastChanges } from '../../events/schema.ts'
import type { ListedMember, SpaceDirectory } from '../../infra/ldap-rest.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { organizations } from '../organizations/schema.ts'
import { reconcileDue, reconcileOrganization } from './reconcile.ts'
import {
  spaceGroups,
  spaceMembers,
  spaceReconciliations,
  spaces
} from './schema.ts'

const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const CAROL = '45c48cce-2e2d-4fbd-a7b9-1e2f3a4b5c6d'
const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const SALES = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
const DESIGNERS = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'
const OLD_GROUP = '0f3d5c1a-8e2b-4a7c-9d6f-1b2c3d4e5f60'
const log = pino({ level: 'silent' })

const person = (uuid: string, username: string, displayName: string) => ({
  uuid,
  username,
  email: `${username}@example.com`,
  displayName
})
const alice = person(ALICE, 'alice', 'Alice Martin')
const bob = person(BOB, 'bob', 'Bob Durand')
const carol = person(CAROL, 'carol', 'Carol Petit')

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  const { db } = testDb
  for (const table of [
    spaceMembers,
    spaceGroups,
    spaces,
    lastChanges,
    spaceReconciliations,
    organizations
  ]) {
    await db.delete(table)
  }
  await db
    .insert(spaces)
    .values({ spaceId: DESIGN, organizationId: 'org-1', name: 'Design' })
  await db.insert(spaceMembers).values([
    { ...copyRow(alice), spaceId: DESIGN, role: 'admin' },
    { ...copyRow(bob), spaceId: DESIGN, role: 'viewer' }
  ])
  await db.insert(spaceGroups).values({
    spaceId: DESIGN,
    groupId: OLD_GROUP,
    name: 'Old',
    role: 'viewer'
  })
})

function copyRow(p: typeof alice) {
  return {
    userId: p.uuid,
    username: p.username,
    email: p.email,
    displayName: p.displayName
  }
}

interface Listed {
  id: string
  name: string
  members: ListedMember[]
  groups: { id: string; name: string; role: 'viewer' | 'editor' | 'admin' }[]
}

function ldapRest(listed: Listed[]) {
  const read: string[] = []
  const directory: Pick<
    SpaceDirectory,
    'list' | 'members' | 'groups' | 'exists'
  > = {
    list: orgId => {
      read.push(orgId)
      return Promise.resolve(listed.map(({ id, name }) => ({ id, name })))
    },
    members: (_org, id) =>
      Promise.resolve(listed.find(s => s.id === id)?.members ?? []),
    groups: (_org, id) =>
      Promise.resolve(listed.find(s => s.id === id)?.groups ?? []),
    exists: (_org, id) => Promise.resolve(listed.some(s => s.id === id))
  }
  return { directory, read }
}

const membersOf = (spaceId: string) =>
  testDb.db
    .select({ userId: spaceMembers.userId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.username))

const spaceNames = async () =>
  (
    await testDb.db
      .select({ id: spaces.spaceId, name: spaces.name })
      .from(spaces)
      .orderBy(asc(spaces.name))
  ).map(s => s.name)

describe('reconcileOrganization', () => {
  it('makes the copy match ldap-rest', async () => {
    const { directory } = ldapRest([
      {
        id: DESIGN,
        name: 'Design team',
        members: [
          { ...alice, role: 'admin' },
          { ...carol, role: 'editor' }
        ],
        groups: [{ id: DESIGNERS, name: 'Designers', role: 'editor' }]
      },
      {
        id: SALES,
        name: 'Sales',
        members: [{ ...bob, role: 'admin' }],
        groups: []
      }
    ])

    await reconcileOrganization(testDb.db, directory, log, 'org-1')

    expect(await spaceNames()).toEqual(['Design team', 'Sales'])
    expect(await membersOf(DESIGN)).toEqual([
      { userId: ALICE, role: 'admin' },
      { userId: CAROL, role: 'editor' }
    ])
    expect(await membersOf(SALES)).toEqual([{ userId: BOB, role: 'admin' }])
    expect(
      await testDb.db
        .select({ groupId: spaceGroups.groupId, role: spaceGroups.role })
        .from(spaceGroups)
    ).toEqual([{ groupId: DESIGNERS, role: 'editor' }])
  })

  it("repairs a member's display name", async () => {
    const { directory } = ldapRest([
      {
        id: DESIGN,
        name: 'Design',
        members: [
          { ...alice, role: 'admin', displayName: 'Alice Moreau' },
          { ...bob, role: 'viewer' }
        ],
        groups: []
      }
    ])

    await reconcileOrganization(testDb.db, directory, log, 'org-1')

    expect(
      await testDb.db
        .select({ displayName: spaceMembers.displayName })
        .from(spaceMembers)
        .where(eq(spaceMembers.userId, ALICE))
    ).toEqual([{ displayName: 'Alice Moreau' }])
  })

  it('deletes a space ldap-rest no longer lists', async () => {
    const { directory } = ldapRest([])

    await reconcileOrganization(testDb.db, directory, log, 'org-1')

    expect(await spaceNames()).toEqual([])
    expect(await membersOf(DESIGN)).toEqual([])
  })

  it('leaves an organization ldap-rest does not know alone', async () => {
    const { directory } = ldapRest([])

    await reconcileOrganization(
      testDb.db,
      { ...directory, list: () => Promise.resolve(undefined) },
      log,
      'org-1'
    )

    expect(await spaceNames()).toEqual(['Design'])
  })

  it('keeps a space the listing skipped but ldap-rest still has', async () => {
    const { directory } = ldapRest([])

    await reconcileOrganization(
      testDb.db,
      { ...directory, exists: () => Promise.resolve(true) },
      log,
      'org-1'
    )

    expect(await spaceNames()).toEqual(['Design'])
  })

  it('skips a space deleted after the listing', async () => {
    const { directory } = ldapRest([])

    await reconcileOrganization(
      testDb.db,
      {
        ...directory,
        list: () => Promise.resolve([{ id: SALES, name: 'Sales' }]),
        members: () => Promise.reject(new Error('space not found'))
      },
      log,
      'org-1'
    )

    expect(await spaceNames()).toEqual([])
  })

  it('keeps a rename applied after it listed the spaces', async () => {
    const { directory } = ldapRest([
      { id: DESIGN, name: 'Stale name', members: [], groups: [] }
    ])

    await reconcileOrganization(
      testDb.db,
      {
        ...directory,
        list: async orgId => {
          const listed = await directory.list(orgId)
          await new Promise(resolve => setTimeout(resolve, 5))
          await testDb.db
            .insert(lastChanges)
            .values({ object: `space:${DESIGN}:name`, at: new Date() })
          return listed
        }
      },
      log,
      'org-1'
    )

    expect(await spaceNames()).toEqual(['Design'])
  })

  it('leaves alone what changed after it read ldap-rest', async () => {
    await testDb.db.insert(lastChanges).values([
      {
        object: `space:${DESIGN}:member:${BOB}`,
        at: new Date(Date.now() + 60_000)
      },
      { object: `space:${DESIGN}:name`, at: new Date(Date.now() + 60_000) }
    ])
    const { directory } = ldapRest([
      {
        id: DESIGN,
        name: 'Stale name',
        members: [{ ...alice, role: 'admin' }],
        groups: []
      }
    ])

    await reconcileOrganization(testDb.db, directory, log, 'org-1')

    expect(await spaceNames()).toEqual(['Design'])
    expect(await membersOf(DESIGN)).toContainEqual({
      userId: BOB,
      role: 'viewer'
    })
  })

  it('keeps a member whose entry ldap-rest cannot read', async () => {
    const { directory } = ldapRest([
      {
        id: DESIGN,
        name: 'Design',
        members: [
          { ...alice, role: 'admin' },
          { username: 'bob', role: 'viewer', displayName: null }
        ],
        groups: []
      }
    ])

    await reconcileOrganization(testDb.db, directory, log, 'org-1')

    expect(await membersOf(DESIGN)).toEqual([
      { userId: ALICE, role: 'admin' },
      { userId: BOB, role: 'viewer' }
    ])
  })
})

describe('reconcileDue', () => {
  const night = new Date('2026-10-06T02:30:00Z')

  it('reconciles each organization once a night, across replicas', async () => {
    await testDb.db.insert(organizations).values([
      { organizationId: 'org-1', domain: 'org-1.example.com' },
      { organizationId: 'org-2', domain: 'org-2.example.com' }
    ])
    const { directory, read } = ldapRest([])

    await Promise.all([
      reconcileDue(testDb.db, directory, log, night),
      reconcileDue(testDb.db, directory, log, night)
    ])
    await reconcileDue(
      testDb.db,
      directory,
      log,
      new Date('2026-10-06T23:00:00Z')
    )
    await reconcileDue(
      testDb.db,
      directory,
      log,
      new Date('2026-10-07T02:00:00Z')
    )

    expect(read.sort()).toEqual(['org-1', 'org-1', 'org-2', 'org-2'])
  })

  it('tries an organization again on the next pass when it fails', async () => {
    await testDb.db
      .insert(organizations)
      .values({ organizationId: 'org-1', domain: 'org-1.example.com' })
    const { directory } = ldapRest([])
    const down = new Error('ldap-rest is down')
    const failing = { ...directory, list: () => Promise.reject(down) }

    const first = await reconcileDue(testDb.db, failing, log, night)
    const second = await reconcileDue(testDb.db, directory, log, night)

    expect(first).toEqual({ attempted: 1, failures: [down] })
    expect(second).toEqual({ attempted: 1, failures: [] })
    expect(await spaceNames()).toEqual([])
  })

  it('attempts nothing once every organization has run tonight', async () => {
    await testDb.db
      .insert(organizations)
      .values({ organizationId: 'org-1', domain: 'org-1.example.com' })
    const { directory } = ldapRest([])

    await reconcileDue(testDb.db, directory, log, night)

    expect(await reconcileDue(testDb.db, directory, log, night)).toEqual({
      attempted: 0,
      failures: []
    })
  })
})
