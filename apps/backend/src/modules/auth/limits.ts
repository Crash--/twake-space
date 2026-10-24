import type { RedisClientType } from 'redis'

export interface Limit {
  max: number
  perMs: number
}

export const perMinute = (max: number): Limit => ({ max, perMs: 60_000 })
export const perHour = (max: number): Limit => ({ max, perMs: 3_600_000 })

// RATE_LIMITS overrides any of these by name.
export const DEFAULT_LIMITS = {
  // A caller's requests across the routes that name no limit. Each change in a
  // space makes every open client read it, so a busy space spends a viewer's
  // budget too.
  any: perMinute(600),
  feedRead: perMinute(120),
  feedPost: perMinute(10),
  feedEdit: perMinute(30),
  feedVote: perMinute(30),
  feedAnswer: perMinute(30),
  feedDecision: perMinute(30),
  feedReaction: perMinute(60),
  // Fetches of links not cached yet, the only previews that cost another site
  // a request.
  linkFetch: perMinute(30),
  // What one author can notify one member of, across posts.
  mention: perHour(20),
  meetingCreate: perHour(30),
  spaceCreate: perHour(20),
  spaceBanner: perHour(20),
  spaceMembers: perMinute(20),
  tokenCreate: perHour(20)
} satisfies Record<string, Limit>

export type LimitName = keyof typeof DEFAULT_LIMITS
export type Limits = Record<LimitName, Limit>

declare module 'fastify' {
  interface FastifyContextConfig {
    limit?: LimitName
  }
}

// Milliseconds until the key may be used again, or 0 when it may now.
export type Limiter = (key: string, limit: Limit) => number | Promise<number>

// Keys are authenticated callers, never addresses: people behind one network
// share an address, so one of them could lock out the rest.
export function fixedWindows(now = Date.now): Limiter {
  const windows = new Map<string, { count: number; endsAt: number }>()
  let sweepAt = 0
  return (key, { max, perMs }) => {
    const at = now()
    if (at >= sweepAt) {
      for (const [stale, { endsAt }] of windows) {
        if (endsAt <= at) windows.delete(stale)
      }
      sweepAt = at + 60_000
    }
    let window = windows.get(key)
    if (!window || window.endsAt <= at) {
      window = { count: 0, endsAt: at + perMs }
      windows.set(key, window)
    }
    window.count += 1
    return window.count > max ? window.endsAt - at : 0
  }
}

const REDIS_WAIT_MS = 200

// Counts shared by every replica and kept across restarts. While Redis cannot
// answer, each replica counts on its own rather than refuse or wait. A
// connection that hangs without closing never fails a command, so the wait is
// capped here.
export function redisWindows(redis: RedisClientType): Limiter {
  const fallback = fixedWindows()
  return async (key, limit) => {
    const name = `twake-space:limit:${key}`
    let timer: NodeJS.Timeout | undefined
    try {
      // SET NX PX rather than PEXPIRE NX, which needs Redis 7.
      const [, count, ttl] = await Promise.race([
        redis
          .multi()
          .set(name, 0, {
            condition: 'NX',
            expiration: { type: 'PX', value: limit.perMs }
          })
          .incr(name)
          .pTTL(name)
          .exec(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('redis too slow'))
          }, REDIS_WAIT_MS)
        })
      ])
      return Number(count) > limit.max ? Math.max(Number(ttl), 1) : 0
    } catch {
      return await fallback(key, limit)
    } finally {
      clearTimeout(timer)
    }
  }
}
