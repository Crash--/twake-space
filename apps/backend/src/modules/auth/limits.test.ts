import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { fixedWindows, perMinute } from './limits.ts'
import { registerAuth } from './routes.ts'
import { aTokenCaller, anIdentity } from './testing.ts'

describe('fixedWindows', () => {
  it('lets max uses through a window, then says how long to wait', () => {
    let at = 0
    const limiter = fixedWindows(() => at)
    const limit = perMinute(2)

    expect(limiter('alice', limit)).toBe(0)
    at = 10_000
    expect(limiter('alice', limit)).toBe(0)
    expect(limiter('alice', limit)).toBe(50_000)
    expect(limiter('bob', limit)).toBe(0)
    at = 60_000
    expect(limiter('alice', limit)).toBe(0)
  })
})

function setUp() {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const unused = () => Promise.reject(new Error('not used in this test'))
  const authorize = registerAuth(app, {
    authenticate: token =>
      Promise.resolve(anIdentity({ userId: token, sessionId: token })),
    authenticateToken: token =>
      Promise.resolve(aTokenCaller({ tokenId: token, scopes: ['space:read'] })),
    provider: { identify: unused, verifyLogoutToken: unused },
    store: { isRevoked: unused, revoke: unused },
    limiter: fixedWindows(() => 0)
  })
  app.post(
    '/posts',
    { preHandler: authorize('space:read'), config: { limit: perMinute(2) } },
    () => 'ok'
  )
  app.get('/feed', { preHandler: authorize('space:read') }, () => 'ok')
  const as = (token: string, method: 'GET' | 'POST', url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
  return { as }
}

describe('authorize', () => {
  it('answers 429 once a caller spends the route limit', async () => {
    const { as } = setUp()

    await as('alice', 'POST', '/posts')
    await as('alice', 'POST', '/posts')
    const response = await as('alice', 'POST', '/posts')

    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('60')
    expect(response.json()).toEqual({ error: 'rate_limited' })
  })

  it('counts each caller and each route on its own', async () => {
    const { as } = setUp()
    await as('alice', 'POST', '/posts')
    await as('alice', 'POST', '/posts')

    expect((await as('bob', 'POST', '/posts')).statusCode).toBe(200)
    expect((await as('tws_bot', 'POST', '/posts')).statusCode).toBe(200)
    expect((await as('alice', 'GET', '/feed')).statusCode).toBe(200)
  })

  it('holds the routes without a limit of their own to the default', async () => {
    const { as } = setUp()

    for (let i = 0; i < 600; i++) await as('alice', 'GET', '/feed')

    expect((await as('alice', 'GET', '/feed')).statusCode).toBe(429)
    expect((await as('bob', 'GET', '/feed')).statusCode).toBe(200)
  })
})
