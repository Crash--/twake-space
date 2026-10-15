import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from '../../infra/db.ts'

export const homeservers = pgTable('homeservers', {
  id: uuid().primaryKey().defaultRandom(),
  url: text().notNull(),
  serverName: text('server_name').notNull(),
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
