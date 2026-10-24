import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import { organizationMembers, spaceMembers, spaces } from '../spaces/schema.ts'
import { apiTokenAuthenticator, type TokenCaller } from './authenticator.ts'
import { registerTokenRoutes } from './routes.ts'
import {
  apiTokens,
  apiTokenSpaces,
  organizationTokenPolicy,
  tokenAudit
} from './schema.ts'

const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const SALES = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
const HR = '6a1f3e2d-8c4b-4a5e-9f7d-2b3c4d5e6f70'
const CI = '2d7e4b1a-9c3f-4e8d-b6a5-0f1e2d3c4b5a'
const CAROL = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'
const DAY = 24 * 60 * 60 * 1000

const DANA = '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b'

const directory = {
  isTechnicalAccount: (organizationId: string, accountId: string) =>
    Promise.resolve(organizationId === 'org-1' && accountId === CI),
  organizationRole: (organizationId: string, accountId: string) =>
    Promise.resolve(roles.get(`${organizationId}|${accountId}`)),
  isMember: (organizationId: string, accountId: string) =>
    Promise.resolve(roles.has(`${organizationId}|${accountId}`))
}
const roles = new Map<
  string,
  { email: string; role: 'owner' | 'admin' | 'member' }
>()
const authenticate = (token: string) =>
  apiTokenAuthenticator(testDb.db, directory)(token)

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  const { db } = testDb
  for (const table of [
    tokenAudit,
    apiTokenSpaces,
    apiTokens,
    organizationTokenPolicy,
    organizationMembers,
    spaceMembers,
    spaces
  ]) {
    await db.delete(table)
  }
  roles.clear()
  roles.set(`org-1|${ALICE}`, { email: 'alice@example.com', role: 'admin' })
  roles.set(`org-1|${BOB}`, { email: 'bob@example.com', role: 'member' })
  roles.set(`org-1|${DANA}`, { email: 'dana@example.com', role: 'owner' })
  roles.set(`org-2|${CAROL}`, { email: 'carol@example.org', role: 'admin' })
  await db.insert(spaces).values([
    { spaceId: DESIGN, organizationId: 'org-1', name: 'Design' },
    { spaceId: SALES, organizationId: 'org-1', name: 'Sales' },
    { spaceId: HR, organizationId: 'org-1', name: 'HR' }
  ])
  await db.insert(organizationMembers).values([
    {
      organizationId: 'org-1',
      userId: ALICE,
      email: 'alice@example.com',
      role: 'admin'
    },
    {
      organizationId: 'org-1',
      userId: BOB,
      email: 'bob@example.com',
      role: 'member'
    }
  ])
  await db.insert(spaceMembers).values([
    {
      spaceId: DESIGN,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin'
    },
    {
      spaceId: SALES,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'viewer'
    }
  ])
})

function setUp(tokenCaller: TokenCaller = aTokenCaller()) {
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
          ? anIdentity({ userId: BOB })
          : token === 'carol'
            ? anIdentity({ userId: CAROL, organizationId: 'org-2' })
            : token === 'alice-at-org-2'
              ? anIdentity({ userId: ALICE, organizationId: 'org-2' })
              : token === 'dana'
                ? anIdentity({ userId: DANA, email: 'dana@example.com' })
                : null,
    token => (token === 'tws_bot' ? tokenCaller : null)
  )
  registerTokenRoutes(app, { db: testDb.db, authorize, directory })
  return (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: object,
    token = 'alice'
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body && { payload: body })
    })
}

const create = (body: object = {}) => ({
  name: 'release bot',
  scopes: ['space:read'],
  spaces: 'all',
  ...body
})

describe('POST /tokens', () => {
  it('returns the token once, valid for 30 days by default', async () => {
    const response = await setUp()('POST', '/tokens', create())

    expect(response.statusCode).toBe(201)
    const created = response.json<{ token: string; expiresAt: string }>()
    expect(created.token).toMatch(/^tws_/)
    const expiresIn = new Date(created.expiresAt).getTime() - Date.now()
    expect(Math.round(expiresIn / DAY)).toBe(30)

    const caller = await authenticate(created.token)
    expect(caller).toMatchObject({
      userId: ALICE,
      organizationId: 'org-1',
      scopes: ['space:read'],
      spaceIds: null
    })
  })

  it('covers a chosen list of the account spaces', async () => {
    const post = setUp()

    const created = await post('POST', '/tokens', create({ spaces: [SALES] }))
    const outside = await post(
      'POST',
      '/tokens',
      create({ spaces: ['00000000-0000-4000-8000-000000000000'] })
    )

    const { token } = created.json<{ token: string }>()
    expect((await authenticate(token))?.spaceIds).toEqual([SALES])
    expect(outside.statusCode).toBe(400)
  })

  it('takes a lifetime in days or a date', async () => {
    const post = setUp()
    const at = new Date(Date.now() + 10 * DAY).toISOString()

    const inDays = await post('POST', '/tokens', create({ expiresInDays: 7 }))
    const onDate = await post('POST', '/tokens', create({ expiresAt: at }))
    const odd = await post('POST', '/tokens', create({ expiresInDays: 12 }))

    expect(
      Math.round(
        (new Date(inDays.json<{ expiresAt: string }>().expiresAt).getTime() -
          Date.now()) /
          DAY
      )
    ).toBe(7)
    expect(onDate.json<{ expiresAt: string }>().expiresAt).toBe(at)
    expect(odd.statusCode).toBe(400)
  })

  it('follows the organization policy', async () => {
    const post = setUp()

    const neverDenied = await post(
      'POST',
      '/tokens',
      create({ expiresAt: null })
    )
    await testDb.db.insert(organizationTokenPolicy).values({
      organizationId: 'org-1',
      allowNoExpiry: true,
      maxLifetimeDays: 90
    })
    const tooLong = await post(
      'POST',
      '/tokens',
      create({ expiresInDays: 365 })
    )
    const never = await post('POST', '/tokens', create({ expiresAt: null }))

    expect(neverDenied.statusCode).toBe(400)
    expect(tooLong.statusCode).toBe(400)
    expect(never.statusCode).toBe(201)
    expect(never.json<{ expiresAt: null }>().expiresAt).toBeNull()
  })

  it('never gives a new token more rights than the token creating it', async () => {
    const post = setUp(
      aTokenCaller({
        userId: ALICE,
        scopes: ['tokens:write', 'space:read'],
        spaceIds: [SALES],
        expiresAt: new Date(Date.now() + 10 * DAY)
      })
    )
    const by = (body: object) =>
      post('POST', '/tokens', create(body), 'tws_bot')

    expect((await by({ scopes: ['space:write'] })).statusCode).toBe(403)
    expect((await by({ spaces: 'all' })).statusCode).toBe(403)
    expect((await by({ spaces: [DESIGN] })).statusCode).toBe(403)
    expect((await by({ spaces: [SALES], expiresInDays: 30 })).statusCode).toBe(
      403
    )
    expect((await by({ spaces: [SALES], expiresInDays: 7 })).statusCode).toBe(
      201
    )
  })

  it('revokes the tokens a token created, down the line, along with it', async () => {
    const call = setUp()
    const parent = await call(
      'POST',
      '/tokens',
      create({
        name: 'parent',
        scopes: ['tokens:write', 'space:read'],
        expiresInDays: 90
      })
    )
    const parentCaller = await authenticate(
      parent.json<{ token: string }>().token
    )
    if (!parentCaller) throw new Error('parent not authenticated')
    const child = await setUp(parentCaller)(
      'POST',
      '/tokens',
      create({
        name: 'child',
        scopes: ['tokens:write', 'space:read'],
        expiresInDays: 30
      }),
      'tws_bot'
    )
    const childCaller = await authenticate(
      child.json<{ token: string }>().token
    )
    if (!childCaller) throw new Error('child not authenticated')
    const grandchild = await setUp(childCaller)(
      'POST',
      '/tokens',
      create({ name: 'grandchild', expiresInDays: 7 }),
      'tws_bot'
    )

    await call('DELETE', `/tokens/${parent.json<{ id: string }>().id}`)

    expect(
      await authenticate(grandchild.json<{ token: string }>().token)
    ).toBeNull()
    expect(
      await testDb.db
        .select({ name: apiTokens.name, reason: apiTokens.revokedReason })
        .from(apiTokens)
        .orderBy(apiTokens.createdAt)
    ).toEqual([
      { name: 'parent', reason: 'revoked by hand' },
      { name: 'child', reason: 'the token that created it was revoked' },
      { name: 'grandchild', reason: 'the token that created it was revoked' }
    ])
  })

  it('needs tokens:write on a token', async () => {
    const response = await setUp()('POST', '/tokens', create(), 'tws_bot')

    expect(response.statusCode).toBe(403)
  })

  it('records the creation in the audit log', async () => {
    const created = await setUp()('POST', '/tokens', create())

    expect(
      await testDb.db
        .select({
          tokenId: tokenAudit.tokenId,
          action: tokenAudit.action,
          actor: tokenAudit.actor
        })
        .from(tokenAudit)
    ).toEqual([
      {
        tokenId: created.json<{ id: string }>().id,
        action: 'created',
        actor: ALICE
      }
    ])
  })
})

describe('GET /tokens', () => {
  it('lists the active tokens of the account, never their secret', async () => {
    const call = setUp()
    await call('POST', '/tokens', create({ name: 'one' }))
    const two = await call(
      'POST',
      '/tokens',
      create({ name: 'two', spaces: [DESIGN] })
    )
    await call('POST', '/tokens', create({ name: 'bob' }), 'bob')
    const revoked = await call('POST', '/tokens', create({ name: 'gone' }))
    await call('DELETE', `/tokens/${revoked.json<{ id: string }>().id}`)

    const response = await call('GET', '/tokens')

    expect(response.json()).toEqual({
      tokens: [
        expect.objectContaining({ name: 'one', spaces: 'all' }),
        expect.objectContaining({
          id: two.json<{ id: string }>().id,
          name: 'two',
          scopes: ['space:read'],
          spaces: [DESIGN],
          lastUsedAt: null
        })
      ]
    })
    expect(response.body).not.toContain('tws_')
  })
})

describe('PATCH and DELETE /tokens/:id', () => {
  it('renames and revokes a token, in the audit log', async () => {
    const call = setUp()
    const created = await call('POST', '/tokens', create())
    const { id, token } = created.json<{ id: string; token: string }>()

    expect(
      (await call('PATCH', `/tokens/${id}`, { name: 'deploy bot' })).statusCode
    ).toBe(204)
    expect((await call('DELETE', `/tokens/${id}`)).statusCode).toBe(204)

    expect(await authenticate(token)).toBeNull()
    const [row] = await testDb.db
      .select({ name: apiTokens.name })
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
    expect(row?.name).toBe('deploy bot')
    expect(
      (await testDb.db.select().from(tokenAudit)).map(a => a.action).sort()
    ).toEqual(['created', 'renamed', 'revoked'])
  })

  it('never touches another account token', async () => {
    const call = setUp()
    const created = await call('POST', '/tokens', create(), 'bob')
    const { id } = created.json<{ id: string }>()

    expect(
      (await call('PATCH', `/tokens/${id}`, { name: 'mine' })).statusCode
    ).toBe(404)
    expect((await call('DELETE', `/tokens/${id}`)).statusCode).toBe(404)
  })
})

const orgToken = (body: object = {}) => create({ role: 'editor', ...body })

describe('organization tokens', () => {
  it('acts with its own role on every space it covers', async () => {
    const call = setUp()

    const created = await call('POST', '/organization/tokens', orgToken())

    expect(created.statusCode).toBe(201)
    const caller = await authenticate(created.json<{ token: string }>().token)
    expect(caller).toMatchObject({
      userId: null,
      role: 'editor',
      organizationId: 'org-1',
      spaceIds: null
    })
    expect(
      (await call('GET', '/organization/tokens')).json<{ tokens: object[] }>()
        .tokens
    ).toEqual([
      expect.objectContaining({ name: 'release bot', role: 'editor' })
    ])
    expect(
      (await call('GET', '/tokens')).json<{ tokens: object[] }>().tokens
    ).toEqual([])
  })

  it('covers any space of the organization', async () => {
    const call = setUp()

    const org = await call(
      'POST',
      '/organization/tokens',
      orgToken({ spaces: [HR] })
    )
    const own = await call('POST', '/tokens', create({ spaces: [HR] }))

    expect(org.statusCode).toBe(201)
    expect(own.statusCode).toBe(400)
  })

  it('needs a role, and only there', async () => {
    const call = setUp()

    expect(
      (await call('POST', '/organization/tokens', create())).statusCode
    ).toBe(400)
    expect(
      (await call('POST', '/tokens', create({ role: 'admin' }))).statusCode
    ).toBe(400)
  })

  it('is managed by organization admins only', async () => {
    const byBob = await setUp()(
      'POST',
      '/organization/tokens',
      orgToken(),
      'bob'
    )
    const byOrgToken = await setUp(
      aTokenCaller({ userId: null, role: 'admin', scopes: ['tokens:write'] })
    )('GET', '/organization/tokens', undefined, 'tws_bot')

    expect(byBob.statusCode).toBe(403)
    expect(byOrgToken.statusCode).toBe(403)
  })

  it("is never managed with an admin's own token", async () => {
    const call = setUp(
      aTokenCaller({
        userId: ALICE,
        scopes: ['tokens:write', 'space:read', 'members:write']
      })
    )

    const created = await call(
      'POST',
      '/organization/tokens',
      orgToken({ role: 'admin', scopes: ['members:write'] }),
      'tws_bot'
    )
    const listed = await call(
      'GET',
      '/organization/tokens',
      undefined,
      'tws_bot'
    )

    expect(created.statusCode).toBe(403)
    expect(created.json()).toMatchObject({
      message: 'the organization tokens are managed from a signed-in session'
    })
    expect(listed.statusCode).toBe(403)
  })

  it('is managed by an admin whose role predates any role change, and remembers it', async () => {
    const call = setUp()

    const created = await call(
      'POST',
      '/organization/tokens',
      orgToken(),
      'dana'
    )

    expect(created.statusCode).toBe(201)
    expect(
      await testDb.db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, DANA))
    ).toEqual([
      {
        organizationId: 'org-1',
        userId: DANA,
        email: 'dana@example.com',
        role: 'owner'
      }
    ])
  })

  it('is refused to a demoted or departed admin even when the copy missed it', async () => {
    const call = setUp()
    roles.set(`org-1|${ALICE}`, { email: 'alice@example.com', role: 'member' })
    const demoted = await call('GET', '/organization/tokens')
    roles.delete(`org-1|${ALICE}`)
    const departed = await call('GET', '/organization/tokens')

    expect(demoted.statusCode).toBe(403)
    expect(departed.statusCode).toBe(403)
  })

  it('renames and revokes only organization tokens', async () => {
    const call = setUp()
    const org = await call('POST', '/organization/tokens', orgToken())
    const own = await call('POST', '/tokens', create())
    const orgId = org.json<{ id: string }>().id
    const ownId = own.json<{ id: string }>().id

    expect(
      (await call('PATCH', `/organization/tokens/${orgId}`, { name: 'ci' }))
        .statusCode
    ).toBe(204)
    expect(
      (await call('DELETE', `/organization/tokens/${ownId}`)).statusCode
    ).toBe(404)
    expect(
      (await call('DELETE', `/organization/tokens/${orgId}`)).statusCode
    ).toBe(204)
  })
})

describe('GET /organization/token-spaces', () => {
  it('lists every space of the organization to its admins', async () => {
    await testDb.db
      .insert(spaces)
      .values({ spaceId: CI, organizationId: 'org-2', name: 'Elsewhere' })
    const call = setUp()

    const listed = await call('GET', '/organization/token-spaces')
    const byBob = await call(
      'GET',
      '/organization/token-spaces',
      undefined,
      'bob'
    )

    expect(listed.json()).toEqual({
      spaces: [
        { id: DESIGN, name: 'Design' },
        { id: HR, name: 'HR' },
        { id: SALES, name: 'Sales' }
      ]
    })
    expect(byBob.statusCode).toBe(403)
  })
})

describe('technical account tokens', () => {
  const url = `/organization/technical-accounts/${CI}/tokens`

  it('acts for the technical account on the spaces it is in', async () => {
    await testDb.db.insert(spaceMembers).values({
      spaceId: HR,
      userId: CI,
      username: 'ci',
      email: 'ci@example.com',
      role: 'editor'
    })
    const call = setUp()

    const outside = await call('POST', url, create({ spaces: [DESIGN] }))
    const created = await call('POST', url, create({ spaces: [HR] }))

    expect(outside.statusCode).toBe(400)
    expect(created.statusCode).toBe(201)
    expect(
      await authenticate(created.json<{ token: string }>().token)
    ).toMatchObject({ userId: CI, spaceIds: [HR] })
    expect(
      (await call('GET', url)).json<{ tokens: object[] }>().tokens
    ).toHaveLength(1)
    expect(
      (await call('GET', '/tokens')).json<{ tokens: object[] }>().tokens
    ).toEqual([])
  })

  it('is refused once the account leaves the directory', async () => {
    const created = await setUp()('POST', url, create())
    const { token } = created.json<{ token: string }>()

    const gone = await apiTokenAuthenticator(testDb.db, {
      ...directory,
      isTechnicalAccount: () => Promise.resolve(false)
    })(token)

    expect(gone).toBeNull()
  })

  it('is managed by organization admins only', async () => {
    const call = setUp()

    const byMember = await call('POST', url, create(), 'bob')
    const forPerson = await call(
      'POST',
      `/organization/technical-accounts/${BOB}/tokens`,
      create()
    )

    expect(byMember.statusCode).toBe(403)
    expect(forPerson.statusCode).toBe(403)
  })

  it('keeps the existence check on a token the account creates for itself', async () => {
    const call = setUp(
      aTokenCaller({ userId: CI, technical: true, scopes: ['tokens:write'] })
    )

    const created = await call(
      'POST',
      '/tokens',
      create({ scopes: ['tokens:write'] }),
      'tws_bot'
    )

    expect(created.statusCode).toBe(201)
    const [row] = await testDb.db
      .select({ technical: apiTokens.technical })
      .from(apiTokens)
    expect(row).toEqual({ technical: true })
  })

  it('alone gets notifications:write', async () => {
    const call = setUp()
    const scopes = ['notifications:write']

    const own = await call('POST', '/tokens', create({ scopes }))
    const org = await call('POST', '/organization/tokens', orgToken({ scopes }))
    const technical = await call('POST', url, create({ scopes }))

    const refusal = {
      error: 'forbidden',
      message: 'notifications:write is for technical accounts'
    }
    expect(own.statusCode).toBe(403)
    expect(own.json()).toEqual(refusal)
    expect(org.statusCode).toBe(403)
    expect(org.json()).toEqual(refusal)
    expect(technical.statusCode).toBe(201)
  })
})

describe('notifications:read', () => {
  it('is for account tokens only', async () => {
    const call = setUp()
    const scopes = ['notifications:read']

    const own = await call('POST', '/tokens', create({ scopes }))
    const org = await call('POST', '/organization/tokens', orgToken({ scopes }))

    expect(own.statusCode).toBe(201)
    expect(org.json()).toEqual({
      error: 'forbidden',
      message: 'notifications:read is for account tokens'
    })
  })
})

describe('feed:write', () => {
  it('is refused to a viewer organization token', async () => {
    const call = setUp()
    const scopes = ['feed:write']

    const viewer = await call(
      'POST',
      '/organization/tokens',
      orgToken({ scopes, role: 'viewer' })
    )
    const editor = await call(
      'POST',
      '/organization/tokens',
      orgToken({ scopes })
    )

    expect(viewer.statusCode).toBe(400)
    expect(editor.statusCode).toBe(201)
  })
})

describe('GET /tokens/self', () => {
  it('describes the calling token, whatever its scopes', async () => {
    const expiresAt = new Date(Date.now() + 10 * DAY)
    const call = setUp(
      aTokenCaller({
        userId: ALICE,
        scopes: ['feed:read'],
        spaceIds: [SALES],
        expiresAt
      })
    )

    const response = await call('GET', '/tokens/self', undefined, 'tws_bot')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: aTokenCaller().tokenId,
      name: 'release bot',
      owner: 'account',
      accountId: ALICE,
      organizationId: 'org-1',
      scopes: ['feed:read'],
      spaces: [SALES],
      role: null,
      expiresAt: expiresAt.toISOString()
    })
  })

  it('names an organization token and a technical account token', async () => {
    const org = await setUp(
      aTokenCaller({ userId: null, role: 'editor', scopes: [] })
    )('GET', '/tokens/self', undefined, 'tws_bot')
    const technical = await setUp(
      aTokenCaller({ userId: CI, technical: true })
    )('GET', '/tokens/self', undefined, 'tws_bot')

    expect(org.json()).toMatchObject({
      owner: 'organization',
      accountId: null,
      role: 'editor',
      spaces: 'all'
    })
    expect(technical.json()).toMatchObject({
      owner: 'technical_account',
      accountId: CI
    })
  })

  it('is for API tokens only', async () => {
    const response = await setUp()('GET', '/tokens/self')

    expect(response.statusCode).toBe(403)
  })
})

describe('organization token policy', () => {
  it('caps the lifetime of new tokens', async () => {
    const call = setUp()

    const before = await call('GET', '/organization/token-policy')
    const put = await call('PUT', '/organization/token-policy', {
      allowNoExpiry: false,
      maxLifetimeDays: 30
    })
    const tooLong = await call('POST', '/tokens', create({ expiresInDays: 90 }))

    expect(before.json()).toEqual({
      allowNoExpiry: false,
      maxLifetimeDays: null
    })
    expect(put.statusCode).toBe(204)
    expect((await call('GET', '/organization/token-policy')).json()).toEqual({
      allowNoExpiry: false,
      maxLifetimeDays: 30
    })
    expect(tooLong.statusCode).toBe(400)
  })

  it('refuses a cap longer than ten years', async () => {
    const cap = await setUp()('PUT', '/organization/token-policy', {
      allowNoExpiry: false,
      maxLifetimeDays: 3651
    })

    expect(cap.statusCode).toBe(400)
  })

  it('is read by every member', async () => {
    await testDb.db.insert(organizationTokenPolicy).values({
      organizationId: 'org-1',
      allowNoExpiry: true,
      maxLifetimeDays: 90
    })

    const read = await setUp()(
      'GET',
      '/organization/token-policy',
      undefined,
      'bob'
    )

    expect(read.json()).toEqual({ allowNoExpiry: true, maxLifetimeDays: 90 })
  })

  it('is set by organization admins only', async () => {
    const response = await setUp()(
      'PUT',
      '/organization/token-policy',
      { allowNoExpiry: true, maxLifetimeDays: null },
      'bob'
    )

    expect(response.statusCode).toBe(403)
  })
})

describe('between organizations', () => {
  beforeEach(async () => {
    await testDb.db.insert(organizationMembers).values({
      organizationId: 'org-2',
      userId: CAROL,
      email: 'carol@example.org',
      role: 'admin'
    })
  })

  it("keeps an organization's tokens, policy and audit log from the admins of another", async () => {
    const call = setUp()
    const org = await call('POST', '/organization/tokens', orgToken())
    const orgId = org.json<{ id: string }>().id
    await call('PUT', '/organization/token-policy', {
      allowNoExpiry: true,
      maxLifetimeDays: 30
    })

    const listed = await call('GET', '/organization/tokens', undefined, 'carol')
    const renamed = await call(
      'PATCH',
      `/organization/tokens/${orgId}`,
      { name: 'hijacked' },
      'carol'
    )
    const revoked = await call(
      'DELETE',
      `/organization/tokens/${orgId}`,
      undefined,
      'carol'
    )
    const audit = await call(
      'GET',
      '/organization/token-audit',
      undefined,
      'carol'
    )
    const policy = await call(
      'GET',
      '/organization/token-policy',
      undefined,
      'carol'
    )
    const onTheirSpace = await call(
      'POST',
      '/organization/tokens',
      orgToken({ spaces: [DESIGN] }),
      'carol'
    )

    expect(listed.json<{ tokens: object[] }>().tokens).toEqual([])
    expect(renamed.statusCode).toBe(404)
    expect(revoked.statusCode).toBe(404)
    expect(audit.json<{ entries: object[] }>().entries).toEqual([])
    expect(policy.json()).toEqual({
      allowNoExpiry: false,
      maxLifetimeDays: null
    })
    expect(onTheirSpace.statusCode).toBe(400)
    expect((await call('GET', '/organization/tokens')).json()).toMatchObject({
      tokens: [{ id: orgId, name: 'release bot' }]
    })
  })

  it('shows a person only the tokens made in the organization they act in', async () => {
    const call = setUp()
    const own = await call('POST', '/tokens', create())
    const ownId = own.json<{ id: string }>().id

    const listed = await call('GET', '/tokens', undefined, 'alice-at-org-2')
    const revoked = await call(
      'DELETE',
      `/tokens/${ownId}`,
      undefined,
      'alice-at-org-2'
    )

    expect(listed.json<{ tokens: object[] }>().tokens).toEqual([])
    expect(revoked.statusCode).toBe(404)
  })
})

describe('organization token audit log', () => {
  it('shows every token change in the organization, newest first', async () => {
    const call = setUp()
    const own = await call('POST', '/tokens', create({ name: 'mine' }), 'bob')
    const org = await call('POST', '/organization/tokens', orgToken())
    await call(
      'DELETE',
      `/organization/tokens/${org.json<{ id: string }>().id}`
    )

    const audit = await call('GET', '/organization/token-audit')
    const byBob = await call(
      'GET',
      '/organization/token-audit',
      undefined,
      'bob'
    )

    expect(audit.json<{ entries: object[] }>().entries).toMatchObject([
      { tokenName: 'release bot', action: 'revoked', actor: ALICE },
      { tokenName: 'release bot', action: 'created', actor: ALICE },
      { tokenName: 'mine', action: 'created', actor: BOB }
    ])
    expect(own.statusCode).toBe(201)
    expect(byBob.statusCode).toBe(403)
  })
})
