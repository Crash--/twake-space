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
export type Limiter = (key: string, limit: Limit) => number

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
