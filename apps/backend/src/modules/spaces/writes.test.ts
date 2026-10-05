import {
  AuthenticationError,
  ConflictError,
  NotFoundError
} from '@linagora/ldap-rest-client'
import { asc, eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lastChanges } from '../../events/schema.ts'
import { createServer } from '../../infra/http.ts'
import type { Person, SpaceDirectory } from '../../infra/ldap-rest.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import type { TokenCaller } from '../tokens/authenticator.ts'
import { spacePlatformRoutes } from './events.ts'
import {
  organizationMembers,
  spaceBanners,
  spaceGroups,
  spaceMembers,
  spaceSettings,
  spaceTab,
  spaces
} from './schema.ts'
import { registerSpaceWriteRoutes } from './writes.ts'

const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const CAROL = '45c48cce-2e2d-4fbd-a7b9-1e2f3a4b5c6d'
const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const CREATED = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
const DESIGNERS = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'
const log = pino({ level: 'silent' })

const people: Person[] = [
  {
    uuid: ALICE,
    username: 'alice',
    email: 'alice@example.com',
    displayName: 'Alice LIDDELL'
  },
  {
    uuid: BOB,
    username: 'bob',
    email: 'bob@example.com',
    displayName: 'Bob MARTIN'
  },
  {
    uuid: CAROL,
    username: 'carol',
    email: 'carol@example.com',
    displayName: 'Carol KING'
  }
]

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
    spaceSettings,
    spaceBanners,
    spaces,
    organizationMembers,
    lastChanges
  ]) {
    await db.delete(table)
  }
  await db
    .insert(spaces)
    .values({ spaceId: DESIGN, organizationId: 'org-1', name: 'Design' })
  await db.insert(spaceMembers).values([
    {
      spaceId: DESIGN,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin'
    },
    {
      spaceId: DESIGN,
      userId: BOB,
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob MARTIN',
      role: 'viewer'
    }
  ])
})

type Call = [string, ...unknown[]]

function ldapRest(refuse?: Error) {
  const calls: Call[] = []
  const write =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return refuse ? Promise.reject(refuse) : Promise.resolve()
    }
  const directory: SpaceDirectory = {
    list: () => Promise.resolve([]),
    members: () => Promise.resolve([]),
    exists: () => Promise.resolve(true),
    person: (_org, by, value) =>
      Promise.resolve(
        people.find(p => (by === 'id' ? p.uuid : p[by]) === value)
      ),
    create: (...args) => {
      calls.push(['create', ...args])
      return Promise.resolve({ id: CREATED })
    },
    rename: write('rename'),
    delete: write('delete'),
    addMembers: write('addMembers'),
    setMemberRole: write('setMemberRole'),
    removeMember: write('removeMember'),
    linkGroups: write('linkGroups'),
    setGroupRole: write('setGroupRole'),
    unlinkGroup: write('unlinkGroup'),
    groups: () =>
      Promise.resolve([{ id: DESIGNERS, name: 'Designers', role: 'viewer' }])
  }
  return { calls, directory }
}

function setUp(
  directory: SpaceDirectory,
  tokenCaller: TokenCaller = aTokenCaller()
) {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    token =>
      token === 'alice'
        ? anIdentity({ userId: ALICE })
        : token === 'bob'
          ? anIdentity({ userId: BOB, email: 'bob@example.com' })
          : token === 'carol'
            ? anIdentity({ userId: CAROL, email: 'carol@example.com' })
            : null,
    token => (token === 'tws_bot' ? tokenCaller : null)
  )
  registerSpaceWriteRoutes(app, { db: testDb.db, authorize, directory })
  return (
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    token = 'alice',
    contentType?: string
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(contentType && { 'content-type': contentType })
      },
      ...(payload && { payload })
    })
}

const stateOf = (spaceId: string, state: 'archived' | 'trashed') =>
  testDb.db.update(spaces).set({ state }).where(eq(spaces.spaceId, spaceId))

const readState = async (spaceId = DESIGN) =>
  (
    await testDb.db
      .select({ state: spaces.state })
      .from(spaces)
      .where(eq(spaces.spaceId, spaceId))
  )[0]?.state

const members = (spaceId = DESIGN) =>
  testDb.db
    .select({ userId: spaceMembers.userId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.username))

const displayNames = () =>
  testDb.db
    .select({
      userId: spaceMembers.userId,
      displayName: spaceMembers.displayName
    })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, DESIGN))
    .orderBy(asc(spaceMembers.username))

const nameOf = async (spaceId: string) =>
  (
    await testDb.db
      .select({ name: spaces.name })
      .from(spaces)
      .where(eq(spaces.spaceId, spaceId))
  )[0]?.name

describe('space writes', () => {
  it('creates a space with its creator as admin, as the creator', async () => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)('POST', '/spaces', {
      name: 'Launch'
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      id: CREATED,
      name: 'Launch',
      role: 'admin'
    })
    expect(calls).toEqual([
      [
        'create',
        'org-1',
        { name: 'Launch', members: [{ username: 'alice', role: 'admin' }] },
        'alice@example.com'
      ]
    ])
    expect(await nameOf(CREATED)).toBe('Launch')
    expect(await members(CREATED)).toEqual([{ userId: ALICE, role: 'admin' }])
    const [space] = await testDb.db
      .select({ createdBy: spaces.createdBy })
      .from(spaces)
      .where(eq(spaces.spaceId, CREATED))
    expect(space?.createdBy).toBe('alice@example.com')
  })

  it('keeps the description, color and apps picked at creation', async () => {
    const { directory } = ldapRest()

    const response = await setUp(directory)('POST', '/spaces', {
      name: 'Launch',
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive']
    })

    expect(response.statusCode).toBe(201)
    expect(await testDb.db.select().from(spaceSettings)).toEqual([
      {
        spaceId: CREATED,
        description: 'Ship it',
        color: '#46a2ff',
        apps: ['drive']
      }
    ])
  })

  it('takes feed out of the apps picked, since every space has one', async () => {
    const { directory } = ldapRest()

    await setUp(directory)('POST', '/spaces', {
      name: 'Launch',
      apps: ['feed', 'drive']
    })

    expect(
      await testDb.db.select({ apps: spaceSettings.apps }).from(spaceSettings)
    ).toEqual([{ apps: ['drive'] }])
  })

  it.each([
    ['an unknown app', { apps: ['contacts'] }],
    ['a color that is not a hex code', { color: 'red' }]
  ])('refuses %s', async (_case, choice) => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)('POST', '/spaces', {
      name: 'Launch',
      ...choice
    })

    expect(response.statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('lets only a space admin change it', async () => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)(
      'PATCH',
      `/spaces/${DESIGN}`,
      { name: 'Renamed' },
      'bob'
    )

    expect(response.statusCode).toBe(403)
    expect(calls).toEqual([])
  })

  it('renames the copy, and the later event changes nothing', async () => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)('PATCH', `/spaces/${DESIGN}`, {
      name: 'Design 2'
    })
    await testDb.db.transaction(tx =>
      (spacePlatformRoutes.get('twake.space.updated') ?? fail())(
        {
          routingKey: 'twake.space.updated',
          messageId: 'm1',
          body: {
            organizationId: 'org-1',
            id: DESIGN,
            name: 'Design 2',
            timestamp: new Date(Date.now() - 1000).toISOString()
          }
        },
        tx,
        log
      )
    )

    expect(response.statusCode).toBe(204)
    expect(calls).toEqual([
      ['rename', 'org-1', DESIGN, 'Design 2', 'alice@example.com']
    ])
    expect(await nameOf(DESIGN)).toBe('Design 2')
  })

  it('changes the apps without asking ldap-rest', async () => {
    const { calls, directory } = ldapRest()
    await testDb.db.insert(spaceSettings).values({
      spaceId: DESIGN,
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive']
    })

    const response = await setUp(directory)('PATCH', `/spaces/${DESIGN}`, {
      apps: ['drive', 'calendar']
    })

    expect(response.statusCode).toBe(204)
    expect(calls).toEqual([])
    expect(await testDb.db.select().from(spaceSettings)).toEqual([
      {
        spaceId: DESIGN,
        description: 'Ship it',
        color: '#46a2ff',
        apps: ['drive', 'calendar']
      }
    ])
  })

  it('changes the apps of a space created elsewhere', async () => {
    const { directory } = ldapRest()

    await setUp(directory)('PATCH', `/spaces/${DESIGN}`, {
      apps: ['chat', 'chat']
    })

    expect(await testDb.db.select().from(spaceSettings)).toEqual([
      { spaceId: DESIGN, description: '', color: null, apps: ['chat'] }
    ])
  })

  it('changes the description without asking ldap-rest', async () => {
    const { calls, directory } = ldapRest()
    await testDb.db.insert(spaceSettings).values({
      spaceId: DESIGN,
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive']
    })

    const response = await setUp(directory)('PATCH', `/spaces/${DESIGN}`, {
      description: '  Ship it twice  '
    })

    expect(response.statusCode).toBe(204)
    expect(calls).toEqual([])
    expect(await testDb.db.select().from(spaceSettings)).toEqual([
      {
        spaceId: DESIGN,
        description: 'Ship it twice',
        color: '#46a2ff',
        apps: ['drive']
      }
    ])
  })

  it('keeps every app on when describing a space created elsewhere', async () => {
    const { directory } = ldapRest()

    await setUp(directory)('PATCH', `/spaces/${DESIGN}`, { description: '' })

    expect(await testDb.db.select().from(spaceSettings)).toEqual([
      {
        spaceId: DESIGN,
        description: '',
        color: null,
        apps: [...spaceTab.enumValues]
      }
    ])
  })

  it.each([
    ['a description over 1000 characters', { description: 'a'.repeat(1001) }],
    ['an empty change', {}],
    ['an unknown app', { apps: ['contacts'] }]
  ])('refuses %s to a space', async (_case, change) => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)(
      'PATCH',
      `/spaces/${DESIGN}`,
      change
    )

    expect(response.statusCode).toBe(400)
    expect(calls).toEqual([])
    expect(await testDb.db.select().from(spaceSettings)).toEqual([])
  })

  it('adds members to the copy with their account ids', async () => {
    const { calls, directory } = ldapRest()

    await setUp(directory)('POST', `/spaces/${DESIGN}/members`, {
      usernames: ['carol'],
      role: 'editor'
    })

    expect(calls).toEqual([
      ['addMembers', 'org-1', DESIGN, ['carol'], 'editor', 'alice@example.com']
    ])
    expect(await members()).toEqual([
      { userId: ALICE, role: 'admin' },
      { userId: BOB, role: 'viewer' },
      { userId: CAROL, role: 'editor' }
    ])
  })

  it('changes and removes a member by account id', async () => {
    const { calls, directory } = ldapRest()
    const write = setUp(directory)

    await write('PATCH', `/spaces/${DESIGN}/members/${BOB}`, {
      role: 'editor'
    })
    const afterChange = await members()
    await write('DELETE', `/spaces/${DESIGN}/members/${BOB}`)

    expect(calls.map(c => c.slice(0, 4))).toEqual([
      ['setMemberRole', 'org-1', DESIGN, 'bob'],
      ['removeMember', 'org-1', DESIGN, 'bob']
    ])
    expect(afterChange).toContainEqual({ userId: BOB, role: 'editor' })
    expect(await members()).toEqual([{ userId: ALICE, role: 'admin' }])
  })

  it.each([
    ['editor', 'editor'],
    ['viewer', 'editor']
  ] as const)(
    'gives a member held through a group their own role, %s, and copies the strongest',
    async (role, held) => {
      const { calls, directory } = ldapRest()
      directory.setMemberRole = () =>
        Promise.reject(
          new NotFoundError('member not found', 'MEMBER_NOT_FOUND')
        )
      await testDb.db
        .update(spaceMembers)
        .set({ role: 'editor' })
        .where(eq(spaceMembers.userId, BOB))

      const response = await setUp(directory)(
        'PATCH',
        `/spaces/${DESIGN}/members/${BOB}`,
        { role }
      )

      expect(response.statusCode).toBe(204)
      expect(calls).toEqual([
        ['addMembers', 'org-1', DESIGN, ['bob'], role, 'alice@example.com']
      ])
      expect(await members()).toContainEqual({ userId: BOB, role: held })
    }
  )

  it('keeps the display names of the members it adds and changes', async () => {
    const write = setUp(ldapRest().directory)

    await write('POST', `/spaces/${DESIGN}/members`, {
      usernames: ['carol'],
      role: 'editor'
    })
    await write('PATCH', `/spaces/${DESIGN}/members/${BOB}`, { role: 'admin' })

    expect(await displayNames()).toEqual([
      { userId: ALICE, displayName: null },
      { userId: BOB, displayName: 'Bob MARTIN' },
      { userId: CAROL, displayName: 'Carol KING' }
    ])
  })

  it("passes on ldap-rest's refusal and keeps the copy", async () => {
    const { directory } = ldapRest(
      new ConflictError('last admin', 'LAST_ADMIN')
    )

    const response = await setUp(directory)(
      'DELETE',
      `/spaces/${DESIGN}/members/${ALICE}`
    )

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'LAST_ADMIN' })
    expect(await members()).toHaveLength(2)
  })

  it('removes a member another admin removed a moment before', async () => {
    const { directory } = ldapRest(
      new NotFoundError('member not found', 'MEMBER_NOT_FOUND')
    )

    const response = await setUp(directory)(
      'DELETE',
      `/spaces/${DESIGN}/members/${BOB}`
    )

    expect(response.statusCode).toBe(204)
    expect(await members()).toEqual([{ userId: ALICE, role: 'admin' }])
  })

  it('answers 500 when ldap-rest refuses its own credentials', async () => {
    const { directory } = ldapRest(new AuthenticationError('bad signature'))

    const response = await setUp(directory)('PATCH', `/spaces/${DESIGN}`, {
      name: 'Renamed'
    })

    expect(response.statusCode).toBe(500)
  })

  it('answers the write ldap-rest took even when the copy fails', async () => {
    const { directory } = ldapRest()
    directory.groups = () => Promise.reject(new Error('ldap-rest is down'))

    const response = await setUp(directory)(
      'POST',
      `/spaces/${DESIGN}/groups`,
      {
        groupIds: [DESIGNERS],
        role: 'viewer'
      }
    )

    expect(response.statusCode).toBe(204)
  })

  it('links a group with the name ldap-rest knows', async () => {
    const { directory } = ldapRest()

    await setUp(directory)('POST', `/spaces/${DESIGN}/groups`, {
      groupIds: [DESIGNERS],
      role: 'viewer'
    })

    expect(
      await testDb.db
        .select({ name: spaceGroups.name, role: spaceGroups.role })
        .from(spaceGroups)
    ).toEqual([{ name: 'Designers', role: 'viewer' }])
  })

  it('deletes the space from the copy', async () => {
    const { directory } = ldapRest()
    await testDb.db
      .insert(spaceSettings)
      .values({ spaceId: DESIGN, description: 'x', apps: ['drive'] })
    await stateOf(DESIGN, 'trashed')

    const response = await setUp(directory)('DELETE', `/spaces/${DESIGN}`)

    expect(response.statusCode).toBe(204)
    expect(await nameOf(DESIGN)).toBeUndefined()
    expect(await members()).toEqual([])
    expect(await testDb.db.select().from(spaceSettings)).toEqual([])
  })

  it('keeps the banner an admin uploads, and replaces it', async () => {
    const { calls, directory } = ldapRest()
    const write = setUp(directory)
    const upload = (image: Buffer, type: string) =>
      write('PUT', `/spaces/${DESIGN}/banner`, image, 'alice', type)

    const first = await upload(Buffer.from('png'), 'image/png')
    const second = await upload(Buffer.from('jpeg'), 'image/jpeg')

    expect(first.statusCode).toBe(204)
    expect(second.statusCode).toBe(204)
    expect(calls).toEqual([])
    expect(
      await testDb.db
        .select({
          contentType: spaceBanners.contentType,
          image: spaceBanners.image
        })
        .from(spaceBanners)
    ).toEqual([{ contentType: 'image/jpeg', image: Buffer.from('jpeg') }])
  })

  it.each([
    ['a member who is no admin', 'bob', 'image/png', 1, 403],
    ['an SVG', 'alice', 'image/svg+xml', 1, 415],
    ['an empty file', 'alice', 'image/png', 0, 415],
    ['an image over 5 MB', 'alice', 'image/png', 5 * 1024 * 1024 + 1, 413]
  ])('refuses a banner from %s', async (_, token, type, size, status) => {
    const { directory } = ldapRest()

    const response = await setUp(directory)(
      'PUT',
      `/spaces/${DESIGN}/banner`,
      Buffer.alloc(size),
      token,
      type
    )

    expect(response.statusCode).toBe(status)
    expect(await testDb.db.select().from(spaceBanners)).toEqual([])
  })

  it('takes a 5 MB image on the banner route only', async () => {
    const { directory } = ldapRest()
    const write = setUp(directory)
    const image = Buffer.alloc(2 * 1024 * 1024)

    const banner = await write(
      'PUT',
      `/spaces/${DESIGN}/banner`,
      image,
      'alice',
      'image/png'
    )
    const elsewhere = await write(
      'PATCH',
      `/spaces/${DESIGN}`,
      image,
      undefined,
      'image/png'
    )

    expect(banner.statusCode).toBe(204)
    expect(elsewhere.statusCode).toBe(413)
  })

  it('refuses an unknown caller before reading the banner', async () => {
    const write = setUp(ldapRest().directory)

    const response = await write(
      'PUT',
      `/spaces/${DESIGN}/banner`,
      Buffer.alloc(6 * 1024 * 1024),
      'nobody',
      'image/png'
    )

    expect(response.statusCode).toBe(401)
  })

  it('deletes the banner with the space', async () => {
    const { directory } = ldapRest()
    await testDb.db.insert(spaceBanners).values({
      spaceId: DESIGN,
      contentType: 'image/png',
      image: Buffer.from('png')
    })
    await stateOf(DESIGN, 'trashed')

    await setUp(directory)('DELETE', `/spaces/${DESIGN}`)

    expect(await testDb.db.select().from(spaceBanners)).toEqual([])
  })

  it('writes as the service for an organization token', async () => {
    const { calls, directory } = ldapRest()
    const write = setUp(
      directory,
      aTokenCaller({ userId: null, role: 'admin', scopes: ['space:write'] })
    )

    const rename = await write(
      'PATCH',
      `/spaces/${DESIGN}`,
      { name: 'Design 3' },
      'tws_bot'
    )
    const create = await write('POST', '/spaces', { name: 'X' }, 'tws_bot')

    expect(rename.statusCode).toBe(204)
    expect(calls).toEqual([['rename', 'org-1', DESIGN, 'Design 3', null]])
    expect(create.statusCode).toBe(403)
  })
})

function fail(): never {
  throw new Error('no handler')
}

describe('archives and the bin', () => {
  const OTHER = '1679091c-5a88-4faf-afb5-e6087eb1b2dc'
  const moveTo = (
    write: ReturnType<typeof setUp>,
    state: string,
    token = 'alice'
  ) => write('PUT', `/spaces/${DESIGN}/state`, { state }, token)

  it('archives a space, moves it to the Bin and restores it, as its admin', async () => {
    const write = setUp(ldapRest().directory)

    expect((await moveTo(write, 'archived')).statusCode).toBe(204)
    expect(await readState()).toBe('archived')
    await moveTo(write, 'trashed')
    expect(await readState()).toBe('trashed')
    await moveTo(write, 'active')
    expect(await readState()).toBe('active')
  })

  it('refuses a member who does not manage the space', async () => {
    const response = await moveTo(
      setUp(ldapRest().directory),
      'archived',
      'bob'
    )

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'not_space_manager' })
  })

  it('lets the person who created the space manage it', async () => {
    await testDb.db
      .update(spaces)
      .set({ createdBy: 'bob@example.com' })
      .where(eq(spaces.spaceId, DESIGN))

    const response = await moveTo(
      setUp(ldapRest().directory),
      'archived',
      'bob'
    )

    expect(response.statusCode).toBe(204)
  })

  it("lets the organization's admins restore a space they are not in", async () => {
    await testDb.db.insert(organizationMembers).values({
      organizationId: 'org-1',
      userId: CAROL,
      email: 'carol@example.com',
      role: 'admin'
    })
    await stateOf(DESIGN, 'trashed')

    const response = await moveTo(
      setUp(ldapRest().directory),
      'active',
      'carol'
    )

    expect(response.statusCode).toBe(204)
    expect(await readState()).toBe('active')
  })

  it.each([
    // An admin token restores, then empties the Bin of the space.
    ['admin', 204, undefined],
    // An editor token manages nothing: the space stays in the Bin.
    ['editor', 404, 'trashed']
  ] as const)(
    'lets an organization token acting as %s manage spaces, or not',
    async (role, restoreStatus, left) => {
      const write = setUp(
        ldapRest().directory,
        aTokenCaller({ userId: null, role, scopes: ['space:write'] })
      )
      await stateOf(DESIGN, 'trashed')

      const restore = await write(
        'PUT',
        `/spaces/${DESIGN}/state`,
        { state: 'active' },
        'tws_bot'
      )
      await stateOf(DESIGN, 'trashed')
      const empty = await write('DELETE', '/spaces/bin', undefined, 'tws_bot')

      expect(restore.statusCode).toBe(restoreStatus)
      expect(empty.statusCode).toBe(204)
      expect(await readState()).toBe(left)
    }
  )

  it('needs the space:write scope', async () => {
    const write = setUp(
      ldapRest().directory,
      aTokenCaller({ userId: null, role: 'admin', scopes: ['space:read'] })
    )

    const responses = await Promise.all([
      write('PUT', `/spaces/${DESIGN}/state`, { state: 'archived' }, 'tws_bot'),
      write('DELETE', '/spaces/bin', undefined, 'tws_bot')
    ])

    expect(responses.map(r => r.statusCode)).toEqual([403, 403])
  })

  it('answers 404 to someone with nothing to do with the space', async () => {
    await stateOf(DESIGN, 'trashed')

    const response = await moveTo(
      setUp(ldapRest().directory),
      'active',
      'carol'
    )

    expect(response.statusCode).toBe(404)
  })

  it('deletes for good only from the Bin', async () => {
    const { calls, directory } = ldapRest()

    const response = await setUp(directory)('DELETE', `/spaces/${DESIGN}`)

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'not_in_bin' })
    expect(calls).toEqual([])
  })

  it('empties the Bin of the spaces the caller manages', async () => {
    const { calls, directory } = ldapRest()
    await testDb.db.insert(spaces).values([
      { spaceId: CREATED, organizationId: 'org-1', name: 'Launch' },
      { spaceId: OTHER, organizationId: 'org-1', name: 'Elsewhere' }
    ])
    await testDb.db.insert(spaceMembers).values({
      spaceId: CREATED,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin'
    })
    for (const id of [DESIGN, CREATED, OTHER]) await stateOf(id, 'trashed')

    const response = await setUp(directory)('DELETE', '/spaces/bin')

    expect(response.statusCode).toBe(204)
    expect(calls.map(([name, , id]) => [name, id])).toEqual([
      ['delete', DESIGN],
      ['delete', CREATED]
    ])
    expect(await readState(OTHER)).toBe('trashed')
    expect(await readState(DESIGN)).toBeUndefined()
  })

  it('counts a space ldap-rest no longer knows as deleted', async () => {
    const { directory } = ldapRest(
      new NotFoundError('space not found', 'SPACE_NOT_FOUND')
    )
    await stateOf(DESIGN, 'trashed')

    const one = await setUp(directory)('DELETE', `/spaces/${DESIGN}`)

    expect(one.statusCode).toBe(204)
    expect(await readState()).toBeUndefined()
  })

  it('stops emptying the Bin at the first failure, the rest kept', async () => {
    const { calls, directory } = ldapRest(new Error('ldap-rest is down'))
    await testDb.db
      .insert(spaces)
      .values({ spaceId: CREATED, organizationId: 'org-1', name: 'Launch' })
    await testDb.db.insert(spaceMembers).values({
      spaceId: CREATED,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin'
    })
    for (const id of [DESIGN, CREATED]) await stateOf(id, 'trashed')

    const response = await setUp(directory)('DELETE', '/spaces/bin')

    expect(response.statusCode).toBe(500)
    expect(calls).toHaveLength(1)
    expect(await readState(DESIGN)).toBe('trashed')
    expect(await readState(CREATED)).toBe('trashed')
  })

  it("gives no say over another organization's space created by the same address", async () => {
    await testDb.db
      .update(spaces)
      .set({ createdBy: 'carol@example.com' })
      .where(eq(spaces.spaceId, DESIGN))
    // Carol's address in another organization, under her own account
    await testDb.db.insert(organizationMembers).values({
      organizationId: 'org-2',
      userId: CAROL,
      email: 'carol@example.com',
      role: 'member'
    })
    const write = setUp(
      ldapRest().directory,
      aTokenCaller({ userId: CAROL, scopes: ['space:write'] })
    )

    const response = await write(
      'PUT',
      `/spaces/${DESIGN}/state`,
      { state: 'archived' },
      'tws_bot'
    )

    expect(response.statusCode).toBe(404)
  })
})
