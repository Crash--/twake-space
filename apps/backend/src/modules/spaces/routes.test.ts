import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import { homeservers, organizations } from '../organizations/schema.ts'
import type { TokenCaller } from '../tokens/authenticator.ts'
import { spaceApp, type SpaceApp } from './resources.ts'
import { registerSpaceRoutes } from './routes.ts'
import {
  organizationMembers,
  spaceBanners,
  spaceGroups,
  spaceMarks,
  spaceMembers,
  spaceResources,
  spaceSettings,
  spaces
} from './schema.ts'

const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const SALES = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
const OTHER_ORG = '1679091c-5a88-4faf-afb5-e6087eb1b2dc'
const DESIGNERS = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  const { db } = testDb
  for (const table of [
    organizationMembers,
    spaceMarks,
    spaceMembers,
    spaceGroups,
    spaceResources,
    spaceSettings,
    spaces,
    organizations,
    homeservers
  ]) {
    await db.delete(table)
  }
  await db.insert(spaces).values([
    { spaceId: DESIGN, organizationId: 'org-1', name: 'Design' },
    { spaceId: SALES, organizationId: 'org-1', name: 'Sales' },
    { spaceId: OTHER_ORG, organizationId: 'org-2', name: 'Elsewhere' }
  ])
  const member = (
    spaceId: string,
    userId: string,
    role: 'viewer' | 'admin'
  ) => ({
    spaceId,
    userId,
    username: userId === ALICE ? 'alice' : 'bob',
    email: userId === ALICE ? 'alice@example.com' : 'bob@example.com',
    displayName: userId === ALICE ? 'Alice LIDDELL' : null,
    role
  })
  await db
    .insert(spaceMembers)
    .values([
      member(DESIGN, ALICE, 'admin'),
      member(DESIGN, BOB, 'viewer'),
      member(SALES, BOB, 'admin'),
      member(OTHER_ORG, ALICE, 'admin')
    ])
  await db.insert(spaceGroups).values({
    spaceId: DESIGN,
    groupId: DESIGNERS,
    name: 'Designers',
    role: 'viewer'
  })
  await db.insert(spaceResources).values({
    spaceId: DESIGN,
    kind: 'drive',
    organizationId: 'org-1',
    resourceId: 'folder-1'
  })
})

function setUp(
  tokenCaller: TokenCaller = aTokenCaller(),
  apps: readonly SpaceApp[] = spaceApp.options
) {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    token => (token === 'alice' ? anIdentity({ userId: ALICE }) : null),
    token => (token === 'tws_bot' ? tokenCaller : null)
  )
  registerSpaceRoutes(app, {
    db: testDb.db,
    authorize,
    apps,
    workplaces: (_, ids) =>
      Promise.resolve(
        new Map(ids.map(id => [id, id === ALICE ? 'alice.twake.app' : null]))
      )
  })
  return (
    url: string,
    token = 'alice',
    method: 'GET' | 'PUT' | 'DELETE' = 'GET'
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` }
    })
}

const reached = (body: { spaces: { id: string; role: string }[] }) =>
  body.spaces.map(({ id, role }) => ({ id, role }))

describe('API tokens', () => {
  it('reaches the spaces of the account it acts for', async () => {
    const response = await setUp(aTokenCaller({ userId: BOB }))(
      '/spaces',
      'tws_bot'
    )

    expect(reached(response.json())).toEqual([
      { id: DESIGN, role: 'viewer' },
      { id: SALES, role: 'admin' }
    ])
  })

  it('reaches only the spaces it covers', async () => {
    const get = setUp(aTokenCaller({ userId: BOB, spaceIds: [SALES] }))

    expect(reached((await get('/spaces', 'tws_bot')).json())).toEqual([
      { id: SALES, role: 'admin' }
    ])
    expect((await get(`/spaces/${DESIGN}`, 'tws_bot')).statusCode).toBe(404)
  })

  it('acts with its own role as an organization token', async () => {
    const response = await setUp(
      aTokenCaller({ userId: null, role: 'editor' })
    )('/spaces', 'tws_bot')

    expect(reached(response.json())).toEqual([
      { id: DESIGN, role: 'editor' },
      { id: SALES, role: 'editor' }
    ])
  })

  it('needs the space:read scope', async () => {
    const response = await setUp(aTokenCaller({ scopes: ['feed:read'] }))(
      '/spaces',
      'tws_bot'
    )

    expect(response.statusCode).toBe(403)
    expect(response.headers['www-authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="space:read"'
    )
  })

  it('refuses an unknown token', async () => {
    const response = await setUp()('/spaces', 'tws_unknown')

    expect(response.statusCode).toBe(401)
  })
})

describe('GET /spaces', () => {
  it("lists the caller's spaces in their organization, with their role", async () => {
    const response = await setUp()('/spaces')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      spaces: [
        {
          id: DESIGN,
          name: 'Design',
          role: 'admin',
          color: null,
          description: '',
          pinnedAt: null,
          openedAt: null,
          manages: true,
          members: [
            {
              id: ALICE,
              username: 'alice',
              displayName: 'Alice LIDDELL',
              workplaceFqdn: 'alice.twake.app'
            },
            {
              id: BOB,
              username: 'bob',
              displayName: null,
              workplaceFqdn: null
            }
          ]
        }
      ]
    })
  })

  it('gives the description picked for each space', async () => {
    await testDb.db.insert(spaceSettings).values({
      spaceId: DESIGN,
      description: 'Brand and product design',
      apps: ['tasks']
    })

    const response = await setUp()('/spaces')

    expect(response.json()).toMatchObject({
      spaces: [{ id: DESIGN, description: 'Brand and product design' }]
    })
  })
})

describe('archived spaces and the Bin', () => {
  const ids = (body: { spaces: { id: string }[] }) =>
    body.spaces.map(space => space.id)
  const moveTo = (spaceId: string, state: 'archived' | 'trashed') =>
    testDb.db.update(spaces).set({ state }).where(eq(spaces.spaceId, spaceId))

  it('leaves archived and binned spaces out of the lists and reads', async () => {
    await moveTo(DESIGN, 'archived')
    const get = setUp(aTokenCaller({ userId: null, role: 'viewer' }))

    expect(ids((await get('/spaces')).json())).toEqual([])
    expect(ids((await get('/spaces', 'tws_bot')).json())).toEqual([SALES])
    expect((await get(`/spaces/${DESIGN}`)).statusCode).toBe(404)
  })

  it('tells which spaces the caller manages', async () => {
    await testDb.db
      .update(spaces)
      .set({ createdBy: 'alice@example.com' })
      .where(eq(spaces.spaceId, SALES))
    await testDb.db.insert(spaceMembers).values({
      spaceId: SALES,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'viewer'
    })

    const response = await setUp()('/spaces')

    expect(
      response
        .json<{ spaces: { id: string; manages: boolean }[] }>()
        .spaces.map(({ id, manages }) => ({ id, manages }))
    ).toEqual([
      { id: DESIGN, manages: true },
      { id: SALES, manages: true }
    ])
    expect((await setUp()(`/spaces/${SALES}`)).json()).toMatchObject({
      role: 'viewer',
      manages: true
    })
  })

  it('lists the binned spaces the caller manages, even outside them', async () => {
    await moveTo(DESIGN, 'trashed')
    await moveTo(SALES, 'trashed')
    await testDb.db.insert(organizationMembers).values({
      organizationId: 'org-1',
      userId: ALICE,
      email: 'alice@example.com',
      role: 'owner'
    })

    const response = await setUp()('/spaces?state=trashed')

    expect(response.json()).toMatchObject({
      spaces: [
        { id: DESIGN, role: 'admin', manages: true },
        { id: SALES, role: null, manages: true }
      ]
    })
    expect(ids((await setUp()('/spaces?state=archived')).json())).toEqual([])
  })

  it('refuses an unknown state', async () => {
    const response = await setUp()('/spaces?state=active')

    expect(response.statusCode).toBe(400)
  })
})

describe('pinned and opened spaces', () => {
  const marks = (body: {
    spaces: { pinnedAt: string | null; openedAt: string | null }[]
  }) => body.spaces.map(({ pinnedAt, openedAt }) => ({ pinnedAt, openedAt }))
  const AT = expect.any(String) as string

  it('pins a space for the caller, and unpins it', async () => {
    const request = setUp()

    expect(
      (await request(`/spaces/${DESIGN}/pin`, 'alice', 'PUT')).statusCode
    ).toBe(204)
    const pinned = marks((await request('/spaces')).json())
    expect(pinned).toEqual([{ pinnedAt: AT, openedAt: null }])

    await request(`/spaces/${DESIGN}/pin`, 'alice', 'DELETE')
    expect(marks((await request('/spaces')).json())).toEqual([
      { pinnedAt: null, openedAt: null }
    ])
  })

  it('remembers when the caller last opened a space, pin kept', async () => {
    const request = setUp()
    await request(`/spaces/${DESIGN}/pin`, 'alice', 'PUT')

    await request(`/spaces/${DESIGN}/opened`, 'alice', 'PUT')

    expect(marks((await request('/spaces')).json())).toEqual([
      { pinnedAt: AT, openedAt: AT }
    ])
    expect((await request(`/spaces/${DESIGN}`)).json()).toMatchObject({
      pinnedAt: AT,
      openedAt: AT
    })
  })

  it("keeps each person's marks to themselves", async () => {
    await testDb.db
      .insert(spaceMarks)
      .values({ spaceId: DESIGN, userId: BOB, pinnedAt: new Date() })

    const response = await setUp()('/spaces')

    expect(marks(response.json())).toEqual([{ pinnedAt: null, openedAt: null }])
  })

  it('answers 404 for a space the caller is not in', async () => {
    const response = await setUp()(`/spaces/${SALES}/pin`, 'alice', 'PUT')

    expect(response.statusCode).toBe(404)
    expect(await testDb.db.select().from(spaceMarks)).toEqual([])
  })

  it('is for people, not tokens', async () => {
    const response = await setUp(aTokenCaller({ userId: ALICE }))(
      `/spaces/${DESIGN}/pin`,
      'tws_bot',
      'PUT'
    )

    expect(response.statusCode).toBe(403)
  })

  it('gives no marks to an organization token', async () => {
    const response = await setUp(
      aTokenCaller({ userId: null, role: 'editor' })
    )('/spaces', 'tws_bot')

    expect(marks(response.json())).toEqual([
      { pinnedAt: null, openedAt: null },
      { pinnedAt: null, openedAt: null }
    ])
  })
})

describe('GET /spaces/apps', () => {
  it('offers the tabs of every app the deployment and the organization provide', async () => {
    await testDb.db.insert(organizations).values({
      organizationId: 'org-1',
      domain: 'org-1.example.com',
      chatAvailable: true,
      mailAvailable: true
    })

    const response = await setUp()('/spaces/apps')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      apps: ['chat', 'tasks', 'drive', 'mail', 'calendar']
    })
  })

  it('leaves out the apps the deployment does not provide', async () => {
    await testDb.db.insert(organizations).values({
      organizationId: 'org-1',
      domain: 'org-1.example.com',
      chatAvailable: true,
      mailAvailable: true
    })

    const response = await setUp(aTokenCaller(), ['tasks', 'mail'])(
      '/spaces/apps'
    )

    expect(response.json()).toEqual({ apps: ['tasks', 'mail'] })
  })

  it("leaves out chat and mail while the organization's chat and mail are off", async () => {
    const response = await setUp()('/spaces/apps')

    expect(response.json()).toEqual({ apps: ['tasks', 'drive', 'calendar'] })
  })
})

describe('GET /spaces/:id', () => {
  it('returns the space with its members, groups and resources', async () => {
    const response = await setUp()(`/spaces/${DESIGN}`)

    expect(response.statusCode).toBe(200)
    const body = response.json<{ resources: unknown[] }>()
    expect(body).toMatchObject({
      id: DESIGN,
      name: 'Design',
      role: 'admin',
      members: [
        {
          id: ALICE,
          username: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice LIDDELL',
          role: 'admin',
          workplaceFqdn: 'alice.twake.app'
        },
        {
          id: BOB,
          username: 'bob',
          email: 'bob@example.com',
          displayName: null,
          role: 'viewer',
          workplaceFqdn: null
        }
      ],
      groups: [{ id: DESIGNERS, name: 'Designers', role: 'viewer' }]
    })
    expect(body.resources).toContainEqual({ kind: 'drive', id: 'folder-1' })
    expect(body.resources).toContainEqual({ kind: 'mailbox', id: null })
    expect(body.resources).toHaveLength(5)
  })

  it('says when the space was created', async () => {
    const createdAt = new Date('2026-10-01T08:00:00Z')
    await testDb.db.update(spaces).set({ createdAt })

    const response = await setUp()(`/spaces/${DESIGN}`)

    expect(response.json()).toMatchObject({
      createdAt: '2026-10-01T08:00:00.000Z'
    })
  })

  it('lists only the resources of the apps this deployment provides', async () => {
    const response = await setUp(aTokenCaller(), ['tasks', 'drive'])(
      `/spaces/${DESIGN}`
    )

    expect(response.json()).toMatchObject({
      resources: [
        { kind: 'drive', id: 'folder-1' },
        { kind: 'project', id: null }
      ]
    })
  })

  it('gives the description, color and apps picked for it', async () => {
    await testDb.db.insert(spaceSettings).values({
      spaceId: DESIGN,
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive']
    })

    const response = await setUp()(`/spaces/${DESIGN}`)

    expect(response.json()).toMatchObject({
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive']
    })
  })

  it('has every app on for a space created elsewhere', async () => {
    const response = await setUp()(`/spaces/${DESIGN}`)

    expect(response.json()).toMatchObject({
      description: '',
      color: null,
      apps: ['chat', 'tasks', 'drive', 'mail', 'calendar']
    })
  })

  it("says whether the organization's chat and mail are on", async () => {
    const get = setUp()
    const before = await get(`/spaces/${DESIGN}`)
    await testDb.db.insert(organizations).values({
      organizationId: 'org-1',
      domain: 'org-1.example.com',
      chatAvailable: true
    })

    const after = await get(`/spaces/${DESIGN}`)

    expect(before.json()).toMatchObject({ chat: false, mail: false })
    expect(after.json()).toMatchObject({ chat: true, mail: false })
  })

  it("gives the URL of the organization's homeserver", async () => {
    const get = setUp()
    const before = await get(`/spaces/${DESIGN}`)
    const [homeserver] = await testDb.db
      .insert(homeservers)
      .values({
        url: 'https://matrix.org-1.example.com',
        serverName: 'org-1.example.com',
        chatUrl: 'https://chat-org-1.example.com'
      })
      .returning({ id: homeservers.id })
    await testDb.db.insert(organizations).values({
      organizationId: 'org-1',
      domain: 'org-1.example.com',
      chatAvailable: true,
      homeserverId: homeserver?.id
    })

    const after = await get(`/spaces/${DESIGN}`)

    expect(before.json()).toMatchObject({ homeserverUrl: null, chatUrl: null })
    expect(after.json()).toMatchObject({
      homeserverUrl: 'https://matrix.org-1.example.com',
      chatUrl: 'https://chat-org-1.example.com'
    })
  })

  it.each([
    ['a space the caller is not in', SALES],
    ['a space of another organization', OTHER_ORG],
    ['a space that does not exist', '00000000-0000-4000-8000-000000000000'],
    ['an id that is not a uuid', 'design']
  ])('answers 404 for %s', async (_case, id) => {
    const response = await setUp()(`/spaces/${id}`)

    expect(response.statusCode).toBe(404)
  })
})

describe('GET /spaces/:id/banner', () => {
  const updatedAt = new Date('2026-10-08T08:00:00Z')
  beforeEach(async () => {
    await testDb.db.delete(spaceBanners)
    await testDb.db.insert(spaceBanners).values([
      {
        spaceId: DESIGN,
        contentType: 'image/webp',
        image: Buffer.from('webp'),
        updatedAt
      },
      {
        spaceId: SALES,
        contentType: 'image/png',
        image: Buffer.from('png')
      }
    ])
  })

  it('gives the version of the banner with the space', async () => {
    const get = setUp()

    expect((await get(`/spaces/${DESIGN}`)).json()).toMatchObject({
      banner: updatedAt.toISOString()
    })
    await testDb.db.delete(spaceBanners)
    expect((await get(`/spaces/${DESIGN}`)).json()).toMatchObject({
      banner: null
    })
  })

  it('serves the banner as it was uploaded', async () => {
    const response = await setUp()(`/spaces/${DESIGN}/banner`)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/webp')
    expect(response.rawPayload).toEqual(Buffer.from('webp'))
  })

  it('answers 404 for a space the caller is not in', async () => {
    const response = await setUp()(`/spaces/${SALES}/banner`)

    expect(response.statusCode).toBe(404)
  })

  it('answers 404 for a space without a banner', async () => {
    await testDb.db.delete(spaceBanners)

    const response = await setUp()(`/spaces/${DESIGN}/banner`)

    expect(response.statusCode).toBe(404)
  })
})

it('asks for a bearer token', async () => {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  registerSpaceRoutes(app, {
    db: testDb.db,
    authorize: fakeAuth(app, () => null),
    apps: [],
    workplaces: () => Promise.resolve(new Map())
  })

  const response = await app.inject({ method: 'GET', url: '/spaces' })

  expect(response.statusCode).toBe(401)
})
