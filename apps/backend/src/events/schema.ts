import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid
} from 'drizzle-orm/pg-core'
import { timestamptz } from '../infra/db.ts'
import type { OutgoingEvent } from './outbox.ts'

export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text().notNull(),
    source: text().notNull(),
    id: text().notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow()
  },
  table => [primaryKey({ columns: [table.consumer, table.source, table.id] })]
)

// Events about a space or member the copy doesn't hold yet, set aside so the
// queue keeps flowing.
export const parkedEvents = pgTable(
  'parked_events',
  {
    source: text().notNull(),
    id: text().notNull(),
    exchange: text().notNull(),
    routingKey: text('routing_key').notNull(),
    messageId: text('message_id'),
    body: jsonb().notNull(),
    reason: text().notNull(),
    parkedAt: timestamptz('parked_at').notNull().defaultNow()
  },
  table => [primaryKey({ columns: [table.source, table.id] })]
)

// Our own activity events, from the transaction that makes them until the
// broker confirms them.
export const outgoingActivity = pgTable(
  'outgoing_activity',
  {
    id: uuid().primaryKey(),
    event: jsonb().$type<OutgoingEvent>().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [index().on(table.createdAt)]
)

// Kept after the object itself is removed, so a replayed event cannot bring it back.
export const lastChanges = pgTable('last_changes', {
  object: text().primaryKey(),
  at: timestamptz('at').notNull()
})
