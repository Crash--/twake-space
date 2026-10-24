import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uuid
} from 'drizzle-orm/pg-core'
import { timestamptz } from '../../infra/db.ts'
import { spaceRole } from '../spaces/schema.ts'

export const tokenOwnerKind = pgEnum('token_owner_kind', [
  'account',
  'organization'
])
export const tokenScope = pgEnum('token_scope', [
  'space:read',
  'space:write',
  'members:write',
  'feed:read',
  'tokens:write',
  'notifications:write',
  'feed:write',
  'notifications:read'
])

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    ownerKind: tokenOwnerKind('owner_kind').notNull(),
    // The account's LDAP entryUUID, as space members are keyed.
    accountId: uuid('account_id'),
    // Checked with ldap-rest's technical accounts rather than its members.
    technical: boolean().notNull().default(false),
    name: text().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: tokenScope().array().notNull(),
    role: spaceRole(),
    allSpaces: boolean('all_spaces').notNull().default(false),
    expiresAt: timestamptz('expires_at'),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdBy: text('created_by').notNull(),
    // The token that created this one, revoked along with it.
    parentTokenId: uuid('parent_token_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow()
  },
  table => [
    index().on(table.organizationId, table.accountId),
    index().on(table.parentTokenId),
    check(
      'api_tokens_owner',
      sql`(${table.ownerKind} = 'account') = (${table.accountId} is not null)`
    ),
    check(
      'api_tokens_role',
      sql`(${table.ownerKind} = 'organization') = (${table.role} is not null)`
    )
  ]
)

export const apiTokenSpaces = pgTable(
  'api_token_spaces',
  {
    tokenId: uuid('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id').notNull()
  },
  table => [
    primaryKey({ columns: [table.tokenId, table.spaceId] }),
    index().on(table.spaceId)
  ]
)

export const organizationTokenPolicy = pgTable(
  'organization_token_policy',
  {
    organizationId: text('organization_id').primaryKey(),
    allowNoExpiry: boolean('allow_no_expiry').notNull().default(false),
    maxLifetimeDays: integer('max_lifetime_days')
  },
  table => [
    check(
      'organization_token_policy_lifetime',
      sql`${table.maxLifetimeDays} > 0`
    )
  ]
)

export const tokenAuditAction = pgEnum('token_audit_action', [
  'created',
  'revoked',
  'renamed'
])

export const tokenAudit = pgTable(
  'token_audit',
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => apiTokens.id),
    action: tokenAuditAction().notNull(),
    actor: text().notNull(),
    at: timestamptz('at').notNull().defaultNow(),
    reason: text()
  },
  table => [index().on(table.tokenId)]
)
