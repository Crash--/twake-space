import type { RedisClientType } from 'redis'

export interface Limit {
  max: number
  perMs: number
}

declare module 'fastify' {
  interface FastifyContextConfig {
    limit?: Limit
  }
}

export const perMinute = (max: number): Limit => ({ max, perMs: 60_000 })
export const perHour = (max: number): Limit => ({ max, perMs: 3_600_000 })

// A caller's requests across the routes that set no limit of their own. Each
// change in a space makes every open client read it, so a busy space spends a
// viewer's budget too.
export const DEFAULT_LIMIT = perMinute(600)

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
