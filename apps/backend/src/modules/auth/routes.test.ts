import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from '../../infra/http.ts'
import type { Authenticate } from './authenticator.ts'
import type { IdentityProvider } from './oidc.ts'
import { registerAuth } from './routes.ts'
import type { AuthStore } from './store.ts'
import { anIdentity } from './testing.ts'
import type { TokenCaller } from '../tokens/authenticator.ts'

function setUp(
  authenticate: Authenticate = () => Promise.resolve(anIdentity()),
  authenticateToken: (token: string) => Promise<TokenCaller | null> = () =>
    Promise.resolve(null),
  logger = pino({ level: 'silent' })
) {
  const app = createServer({
    logger,
    isReady: () => Promise.resolve(true)
  })
  const provider: IdentityProvider = {
    identify: vi.fn(),
    verifyLogoutToken: vi.fn((token: string) =>
      token === 'valid'
        ? Promise.resolve('session-1')
        : Promise.reject(new Error('invalid'))
    )
  }
  const store = {
    isRevoked: vi.fn(),
    revoke: vi.fn(() => Promise.resolve())
  } satisfies AuthStore
  const authorize = registerAuth(app, {
    authenticate,
    authenticateToken,
    provider,
    store
  })
  app.get(
    '/me',
    { preHandler: authorize('space:read') },
    request => request.caller
  )
  return { app, store }
}

describe('requireIdentity', () => {
  it('asks for a bearer token', async () => {
    const { app } = setUp()

    const response = await app.inject({ method: 'GET', url: '/me' })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('refuses an invalid token', async () => {
    const { app } = setUp(() => Promise.resolve(null))

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer nope' }
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token"'
    )
  })

  it('answers 503 when the token cannot be checked', async () => {
    const { app } = setUp(() => Promise.reject(new Error('sso down')))

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer token' }
    })

    expect(response.statusCode).toBe(503)
  })

  it('answers 503 when an API token cannot be checked', async () => {
    const { app } = setUp(undefined, () =>
      Promise.reject(new Error('database down'))
    )

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer tws_token' }
    })

    expect(response.statusCode).toBe(503)
  })

  it('reports one error when OIDC stays down, whatever API tokens do', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const levels: { level: number; msg: string }[] = []
      const logger = pino(
        {},
        {
          write: (line: string) => {
            levels.push(JSON.parse(line) as { level: number; msg: string })
          }
        }
      )
      const { app } = setUp(
        () => Promise.reject(new Error('oidc down')),
        () => Promise.resolve(null),
        logger
      )

      for (const minute of [0, 10, 20, 30]) {
        vi.setSystemTime(minute * 60_000)
        for (const token of ['session-token', 'tws_unknown']) {
          await app.inject({
            method: 'GET',
            url: '/me',
            headers: { authorization: `Bearer ${token}` }
          })
        }
      }

      const failures = levels.filter(line => line.msg.includes('check failed'))
      expect(failures).toEqual([
        expect.objectContaining({
          level: 40,
          msg: 'access token check failed'
        }),
        expect.objectContaining({
          level: 50,
          msg: 'access token check failed for over 25 minutes'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a user outside any organization', async () => {
    const { app } = setUp(() =>
      Promise.resolve(anIdentity({ organizationId: null }))
    )

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer token' }
    })

    expect(response.statusCode).toBe(403)
  })

  it('passes the identity to the route', async () => {
    const { app } = setUp()

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer token' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      email: 'alice@example.com',
      sessionId: 'session-1',
      organizationId: 'org-1'
    })
  })
})

describe('POST /auth/backchannel-logout', () => {
  it('revokes the session of a valid logout token', async () => {
    const { app, store } = setUp()

    const response = await app.inject({
      method: 'POST',
      url: '/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=valid'
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(store.revoke).toHaveBeenCalledWith('session-1', expect.any(Date))
  })

  it.each([['logout_token=forged'], ['']])('refuses %j', async payload => {
    const { app, store } = setUp()

    const response = await app.inject({
      method: 'POST',
      url: '/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(store.revoke).not.toHaveBeenCalled()
  })
})
