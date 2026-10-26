import { and, eq, lt, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Db } from '../infra/db.ts'
import { failureStreak } from '../infra/failing.ts'
import type { DeadLetter, IncomingMessage, Outcome, Park } from './router.ts'
import { parkedEvents } from './schema.ts'

// As long as RabbitMQ's default consumer_timeout, so the late platform event
// can arrive from behind a message that keeps failing.
export const WAIT_SECONDS = 30 * 60
const RETRY_EVERY_MS = 5000
const BATCH = 100

export function parkIn(db: Db): Park {
  return async (message, key, reason) => {
    await db
      .insert(parkedEvents)
      .values({
        ...key,
        exchange: message.exchange,
        routingKey: message.routingKey,
        messageId: message.messageId ?? null,
        body: message.body,
        reason
      })
      .onConflictDoNothing()
  }
}

export async function retryParked(
  db: Db,
  handle: (message: IncomingMessage) => Promise<Outcome>,
  deadLetter: DeadLetter,
  log: Logger
): Promise<unknown[]> {
  // What kept each expired event out of the dead letter queue.
  const undelivered: unknown[] = []
  const rows = await db
    .select()
    .from(parkedEvents)
    .orderBy(parkedEvents.parkedAt)
    .limit(BATCH)
  for (const row of rows) {
    const message: IncomingMessage = {
      exchange: row.exchange,
      routingKey: row.routingKey,
      ...(row.messageId !== null && { messageId: row.messageId }),
      body: row.body
    }
    const context = { routingKey: row.routingKey, id: row.id }
    const done = and(
      eq(parkedEvents.source, row.source),
      eq(parkedEvents.id, row.id)
    )
    let outcome: Outcome
    try {
      outcome = await handle(message)
    } catch (error) {
      log.warn({ err: error, ...context }, 'parked event failed')
      continue
    }
    if (outcome === 'parked') {
      // The row goes only once the dead letter is sent.
      await db
        .transaction(async tx => {
          const [expired] = await tx
            .delete(parkedEvents)
            .where(
              and(
                done,
                lt(
                  parkedEvents.parkedAt,
                  sql`now() - make_interval(secs => ${WAIT_SECONDS})`
                )
              )
            )
            .returning({ reason: parkedEvents.reason })
          if (!expired) return
          await deadLetter(message, expired.reason)
          log.warn(
            { ...context, reason: expired.reason },
            'parked event sent to the dead letter queue'
          )
        })
        .catch((error: unknown) => {
          undelivered.push(error)
          log.warn(
            { err: error, ...context },
            'parked event could not reach the dead letter queue'
          )
        })
      continue
    }
    await db.delete(parkedEvents).where(done)
  }
  return undelivered
}

// One replica retries at a time, so a parked event is handled once. Without
// the turn, undefined: another replica's outcome is not this one's to count.
export function retryParkedInTurn(
  db: Db,
  handle: (message: IncomingMessage) => Promise<Outcome>,
  deadLetter: DeadLetter,
  log: Logger
): Promise<unknown[] | undefined> {
  return db.transaction(async tx => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('parked_events')) as locked`
    )
    return lock?.locked ? retryParked(db, handle, deadLetter, log) : undefined
  })
}

export function scheduleParkedRetries(
  db: Db,
  handle: (message: IncomingMessage) => Promise<Outcome>,
  deadLetter: DeadLetter,
  log: Logger
): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()
  const passes = failureStreak(log, 'retrying parked events failed')
  const deadLetters = failureStreak(
    log,
    'parked events could not reach the dead letter queue'
  )
  const loop = () => {
    running = retryParkedInTurn(db, handle, deadLetter, log)
      .then(
        undelivered => {
          if (!undelivered) return
          passes.succeeded()
          if (undelivered.length === 0) deadLetters.succeeded()
          else {
            deadLetters.failed({
              err: undelivered.at(-1),
              undelivered: undelivered.length
            })
          }
        },
        (error: unknown) => {
          passes.failed({ err: error })
        }
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, RETRY_EVERY_MS)
      })
  }
  loop()
  // A pass may still dead-letter, so the broker connection must outlive it.
  return () => {
    stopped = true
    clearTimeout(timer)
    return running
  }
}
