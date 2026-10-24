import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import type { RedisClientType } from 'redis'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { connectRedis } from '../../infra/redis.ts'
import {
  DEFAULT_LIMITS,
  fixedWindows,
  perMinute,
  redisWindows
} from './limits.ts'
import { registerAuth } from './routes.ts'
import { aTokenCaller, anIdentity } from './testing.ts'

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379'

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

describe('redisWindows', () => {
  const log = pino({ level: 'silent' })
  const clients: RedisClientType[] = []
  afterAll(() => {
    for (const client of clients) client.destroy()
  })
  const limiterAt = async (url: string, ready = true) => {
    const client = connectRedis(url, log)
    clients.push(client)
    if (ready) {
      await vi.waitFor(() => {
        expect(client.isReady).toBe(true)
      })
    }
    return redisWindows(client)
  }

  it('counts in Redis, so every replica shares the window', async () => {
    const [first, second] = await Promise.all([
      limiterAt(TEST_REDIS_URL),
      limiterAt(TEST_REDIS_URL)
    ])
    const alice = `alice-${randomUUID()}`
    const limit = perMinute(2)

    expect(await first(alice, limit)).toBe(0)
    expect(await second(alice, limit)).toBe(0)
    const waitMs = await first(alice, limit)

    expect(waitMs).toBeGreaterThan(59_000)
    expect(waitMs).toBeLessThanOrEqual(60_000)
    expect(await second(`bob-${randomUUID()}`, limit)).toBe(0)
  })

  it('counts in memory while Redis cannot answer', async () => {
    const limiter = await limiterAt('redis://127.0.0.1:1', false)
    const limit = perMinute(1)

    expect(await limiter('alice', limit)).toBe(0)
    expect(await limiter('alice', limit)).toBeGreaterThan(0)
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
    limiter: fixedWindows(() => 0),
    limits: { ...DEFAULT_LIMITS, any: perMinute(3), feedPost: perMinute(2) }
  })
  const posting = {
    preHandler: authorize('space:read'),
    config: { limit: 'feedPost' as const }
  }
  app.post('/posts', posting, () => 'ok')
  app.post('/polls', posting, () => 'ok')
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

  it('counts each caller and each limit on its own', async () => {
    const { as } = setUp()
    await as('alice', 'POST', '/posts')
    await as('alice', 'POST', '/posts')

    expect((await as('bob', 'POST', '/posts')).statusCode).toBe(200)
    expect((await as('tws_bot', 'POST', '/posts')).statusCode).toBe(200)
    expect((await as('alice', 'GET', '/feed')).statusCode).toBe(200)
  })

  it('shares one budget between the routes naming the same limit', async () => {
    const { as } = setUp()
    await as('alice', 'POST', '/posts')
    await as('alice', 'POST', '/posts')

    expect((await as('alice', 'POST', '/polls')).statusCode).toBe(429)
  })

  it('holds the routes naming no limit to the "any" limit', async () => {
    const { as } = setUp()

    for (let i = 0; i < 3; i++) await as('alice', 'GET', '/feed')

    expect((await as('alice', 'GET', '/feed')).statusCode).toBe(429)
    expect((await as('bob', 'GET', '/feed')).statusCode).toBe(200)
  })
})
