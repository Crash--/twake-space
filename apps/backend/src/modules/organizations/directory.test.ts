import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createServer } from '../../infra/http.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import { registerDirectoryRoutes } from './directory.ts'

const DESIGNERS = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'
const alice = {
  username: 'alice',
  email: 'alice@example.com',
  displayName: 'Alice Martin',
  firstName: 'Alice',
  lastName: 'Martin'
}

function setUp() {
  const queries: unknown[] = []
  const directory: Pick<Directory, 'listMembers' | 'listGroups'> = {
    listMembers: (orgId, query) => {
      queries.push(['members', orgId, query])
      return Promise.resolve({ members: [alice], total: 21, hasNextPage: true })
    },
    listGroups: (orgId, query) => {
      queries.push(['groups', orgId, query])
      return Promise.resolve({
        groups: [{ id: DESIGNERS, name: 'Designers' }],
        hasNextPage: false
      })
    }
  }
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    token => (token === 'alice' ? anIdentity() : null),
    token =>
      token === 'tws_bot'
        ? aTokenCaller()
        : token === 'tws_crew'
          ? aTokenCaller({
              organizationId: 'org-2',
              userId: null,
              role: 'admin',
              scopes: ['members:write']
            })
          : token === 'tws_viewer'
            ? aTokenCaller({
                userId: null,
                role: 'viewer',
                scopes: ['members:write']
              })
            : null
  )
  registerDirectoryRoutes(app, { authorize, directory })
  const get = (url: string, token = 'alice') =>
    app.inject({ url, headers: { authorization: `Bearer ${token}` } })
  return { get, queries }
}

describe('GET /organization/members', () => {
  it("searches the caller's organization by page", async () => {
    const { get, queries } = setUp()

    const response = await get('/organization/members?search=ali&page=2')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      members: [
        {
          username: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice Martin'
        }
      ],
      hasNextPage: true
    })
    expect(queries).toEqual([
      ['members', 'org-1', { page: 2, limit: 20, search: 'ali' }]
    ])
  })

  it('lists the first page without a search', async () => {
    const { get, queries } = setUp()

    await get('/organization/members')

    expect(queries).toEqual([['members', 'org-1', { page: 1, limit: 20 }]])
  })

  it('refuses a search under two characters', async () => {
    const { get } = setUp()

    const response = await get('/organization/members?search=a')

    expect(response.statusCode).toBe(400)
  })

  it('lets in a token that manages members, of its organization', async () => {
    const { get, queries } = setUp()

    const response = await get('/organization/members?search=ali', 'tws_crew')

    expect(response.statusCode).toBe(200)
    expect(queries).toEqual([
      ['members', 'org-2', { page: 1, limit: 20, search: 'ali' }]
    ])
  })

  it('refuses a token that adds no one, and an unknown token', async () => {
    const { get } = setUp()

    expect((await get('/organization/members', 'tws_bot')).statusCode).toBe(403)
    expect((await get('/organization/groups', 'tws_viewer')).statusCode).toBe(
      403
    )
    expect((await get('/organization/members', 'nobody')).statusCode).toBe(401)
  })
})

describe('GET /organization/groups', () => {
  it("searches the caller's organization's groups by page", async () => {
    const { get, queries } = setUp()

    const response = await get('/organization/groups?search=des')

    expect(response.json()).toEqual({
      groups: [{ id: DESIGNERS, name: 'Designers' }],
      hasNextPage: false
    })
    expect(queries).toEqual([
      ['groups', 'org-1', { page: 1, limit: 20, search: 'des' }]
    ])
  })
})
