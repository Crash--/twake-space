import { and, eq, lt, notExists, or, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Db } from '../../infra/db.ts'
import { notifications } from '../notifications/schema.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPosts
} from './schema.ts'

const PURGE_EVERY_MS = 60 * 60 * 1000

const daysBefore = (now: Date, days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

// False when another replica holds the lock and is purging.
export function purgeExpired(db: Db, now = new Date()): Promise<boolean> {
  return db.transaction(async tx => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('purge')) as locked`
    )
    if (!lock?.locked) return false
    const feedLimit = daysBefore(now, 365)
    await tx
      .delete(activityEvents)
      .where(lt(activityEvents.createdAt, feedLimit))
    await tx.delete(feedPosts).where(lt(feedPosts.time, feedLimit))
    // Also those on a card whose events are all purged, or on a deleted post.
    await tx
      .delete(feedItemReactions)
      .where(
        or(
          lt(feedItemReactions.createdAt, feedLimit),
          and(
            notExists(
              tx
                .select({ id: feedCards.id })
                .from(feedCards)
                .where(eq(feedCards.id, feedItemReactions.itemId))
            ),
            notExists(
              tx
                .select({ id: feedPosts.id })
                .from(feedPosts)
                .where(eq(feedPosts.id, feedItemReactions.itemId))
            )
          )
        )
      )
    await tx
      .delete(notifications)
      .where(lt(notifications.createdAt, daysBefore(now, 90)))
    return true
  })
}

export function schedulePurge(db: Db, logger: Logger): () => void {
  const purge = () => {
    purgeExpired(db).catch((error: unknown) => {
      logger.error({ err: error }, 'purge failed')
    })
  }
  // Also at startup, so pods restarted more often than hourly still purge.
  purge()
  const timer = setInterval(purge, PURGE_EVERY_MS)
  return () => {
    clearInterval(timer)
  }
}
