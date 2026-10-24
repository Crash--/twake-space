import { asc, eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import { afterCommit, type Db, type Tx } from '../infra/db.ts'
import { scheduleSweep } from '../infra/sweep.ts'
import { outgoingActivity } from './schema.ts'

const SWEEP_EVERY_MS = 10_000

export interface OutgoingEvent extends Record<string, unknown> {
  id: string
  type: string
}

export type PublishActivity = (
  routingKey: string,
  event: OutgoingEvent
) => Promise<void>

let nudge: () => void = () => undefined

/** Stores the events for the sweep to publish once the transaction commits. */
export async function publishLater(
  tx: Tx,
  events: OutgoingEvent[]
): Promise<void> {
  if (events.length === 0) return
  await tx
    .insert(outgoingActivity)
    .values(events.map(event => ({ id: event.id, event })))
  afterCommit(tx, () => {
    nudge()
  })
}

// Stops at the first failure: the next sweep tries again. The row lock keeps
// other replicas off the event while it is published.
export async function publishActivity(
  db: Db,
  publish: PublishActivity,
  stopped = () => false
): Promise<void> {
  while (!stopped()) {
    const published = await db.transaction(async tx => {
      const [pending] = await tx
        .select({ id: outgoingActivity.id, event: outgoingActivity.event })
        .from(outgoingActivity)
        .orderBy(asc(outgoingActivity.createdAt))
        .limit(1)
        .for('update', { skipLocked: true })
      if (!pending) return false
      await publish(pending.event.type, pending.event)
      await tx
        .delete(outgoingActivity)
        .where(eq(outgoingActivity.id, pending.id))
      return true
    })
    if (!published) return
  }
}

export function scheduleActivity(
  db: Db,
  publish: PublishActivity,
  logger: Pick<Logger, 'warn'>
): () => Promise<void> {
  const sweep = scheduleSweep(
    stopped => publishActivity(db, publish, stopped),
    SWEEP_EVERY_MS,
    error => {
      logger.warn({ err: error }, 'activity events were not published')
    }
  )
  nudge = sweep.nudge
  return () => {
    nudge = () => undefined
    return sweep.stop()
  }
}
