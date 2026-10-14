import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid
} from 'drizzle-orm/pg-core'
import { timestamptz } from '../../infra/db.ts'
import { homeservers } from '../organizations/schema.ts'

// A user's id is null when only their email was sent and no space member has it.
export type Actor =
  | { type: 'user'; id: string | null; email: string | null }
  | { type: 'token'; id: string; name: string }
  | { type: 'deleted_user' }

export const feedCategory = pgEnum('feed_category', [
  'messages',
  'files',
  'activities',
  'events'
])

export const activityEvents = pgTable(
  'activity_events',
  {
    // Also the Matrix transaction id of the card: CloudEvent ids are only unique per source.
    id: uuid().primaryKey().defaultRandom(),
    source: text().notNull(),
    eventId: text('event_id').notNull(),
    // Null for a B2C user's event.
    organizationId: text('organization_id'),
    // Null for an object outside any space: used for personal notifications only.
    spaceId: uuid('space_id'),
    type: text().notNull(),
    category: feedCategory().notNull(),
    // Null for an event no one in particular made.
    actor: jsonb().$type<Actor>(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    content: jsonb().notNull(),
    time: timestamptz('time').notNull(),
    matrixEventId: text('matrix_event_id'),
    // Set when the homeserver refused the card for good; it is not retried.
    postFailedAt: timestamptz('post_failed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [
    unique().on(table.source, table.eventId),
    index('activity_events_unposted_idx')
      .on(table.spaceId, table.time)
      .where(
        sql`${table.matrixEventId} is null and ${table.postFailedAt} is null and ${table.spaceId} is not null`
      ),
    index().on(table.spaceId, table.objectType, table.objectId, table.time),
    // For a late provisioned event to find the events on its container.
    index('activity_events_unattached_idx')
      .on(
        sql`(${table.content}->'object'->'container'->>'kind')`,
        sql`(${table.content}->'object'->'container'->>'id')`
      )
      .where(sql`${table.spaceId} is null`),
    index().on(table.createdAt)
  ]
)

export const feedMessages = pgTable(
  'feed_messages',
  {
    matrixEventId: text('matrix_event_id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    sender: text().notNull(),
    content: jsonb().notNull(),
    originServerTs: timestamptz('origin_server_ts').notNull(),
    editedContent: jsonb('edited_content'),
    editedAt: timestamptz('edited_at'),
    redactedAt: timestamptz('redacted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [index().on(table.createdAt)]
)

export const feedReactions = pgTable(
  'feed_reactions',
  {
    matrixEventId: text('matrix_event_id').primaryKey(),
    // Null on reactions stored before reactions were scoped to their space.
    spaceId: uuid('space_id'),
    targetEventId: text('target_event_id').notNull(),
    sender: text().notNull(),
    key: text().notNull(),
    redactedAt: timestamptz('redacted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [index().on(table.createdAt)]
)

// One per object in a space: later events about it change the card in place.
export const feedCards = pgTable(
  'feed_cards',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    // Set on a Drive folder digest, which is one per member.
    memberId: uuid('member_id'),
    category: feedCategory().notNull(),
    // The first event's, so the card keeps its place in the feed; a folder
    // digest's latest window's, so it moves to the top.
    time: timestamptz('time').notNull(),
    latestEventId: uuid('latest_event_id')
      .notNull()
      .references(() => activityEvents.id, { onDelete: 'cascade' }),
    latestTime: timestamptz('latest_time').notNull()
  },
  table => [
    unique()
      .on(table.spaceId, table.objectType, table.objectId, table.memberId)
      .nullsNotDistinct(),
    index().on(table.spaceId, table.time, table.id)
  ]
)

export const feedPosts = pgTable(
  'feed_posts',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    // Null once the author's account is deleted.
    authorId: uuid('author_id'),
    body: text().notNull(),
    // Written from a JS Date, at the milliseconds the feed cursor carries.
    time: timestamptz('time').notNull(),
    editedAt: timestamptz('edited_at')
  },
  table => [index().on(table.spaceId, table.time, table.id)]
)

// On a card or a post.
export const feedItemReactions = pgTable(
  'feed_item_reactions',
  {
    itemId: uuid('item_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    key: text().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [
    primaryKey({ columns: [table.itemId, table.userId, table.key] }),
    index().on(table.createdAt)
  ]
)

// The time of the newest item a member has seen in a space's feed.
export const feedReads = pgTable(
  'feed_reads',
  {
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    readAt: timestamptz('read_at').notNull()
  },
  table => [primaryKey({ columns: [table.spaceId, table.userId] })]
)

// Synapse resends a transaction until it gets a 200.
export const appServiceTransactions = pgTable(
  'app_service_transactions',
  {
    homeserverId: uuid('homeserver_id')
      .notNull()
      .references(() => homeservers.id, { onDelete: 'cascade' }),
    txnId: text('txn_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [
    primaryKey({ columns: [table.homeserverId, table.txnId] }),
    index().on(table.createdAt)
  ]
)
