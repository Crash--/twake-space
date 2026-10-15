import { boolean, bytea, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from '../../infra/db.ts'

// The hs_token tells which homeserver sent a transaction, never which
// organization: one homeserver can serve several, so that comes from the room.
export const homeservers = pgTable('homeservers', {
  id: uuid().primaryKey().defaultRandom(),
  url: text().notNull(),
  serverName: text('server_name').notNull(),
  // AES-256-GCM ciphertexts
  asToken: bytea('as_token').notNull(),
  hsToken: bytea('hs_token').notNull(),
  hsTokenHash: text('hs_token_hash').notNull().unique(),
  // Where the browser frames Chat for this homeserver's organizations; none
  // falls back to the deployment's CHAT_URL.
  chatUrl: text('chat_url'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow()
})

export const organizations = pgTable('organizations', {
  organizationId: text('organization_id').primaryKey(),
  domain: text().notNull(),
  chatAvailable: boolean('chat_available').notNull().default(false),
  mailAvailable: boolean('mail_available').notNull().default(false),
  homeserverId: uuid('homeserver_id').references(() => homeservers.id),
  updatedAt: timestamptz('updated_at').notNull().defaultNow()
})
