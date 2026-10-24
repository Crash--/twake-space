import type { Logger } from 'pino'
import { createClient, type RedisClientType } from 'redis'

// Never awaited at startup and never queues a command while disconnected, so
// a Redis outage fails each call at once instead of holding requests.
export function connectRedis(url: string, log: Logger): RedisClientType {
  const client: RedisClientType = createClient({
    url,
    disableOfflineQueue: true
  })
  // The client retries every few seconds while Redis is down, failing each time.
  let down = false
  client.on('error', (error: unknown) => {
    if (down) return
    down = true
    log.warn({ err: error }, 'redis unavailable')
  })
  client.on('ready', () => {
    if (down) log.info('redis available again')
    down = false
  })
  client.connect().catch((error: unknown) => {
    log.warn({ err: error }, 'redis connection failed')
  })
  return client
}
