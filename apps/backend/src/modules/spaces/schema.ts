import {
  bytea,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uuid
} from 'drizzle-orm/pg-core'
import { timestamptz } from '../../infra/db.ts'

export const spaceRole = pgEnum('space_role', ['viewer', 'editor', 'admin'])

// Twake Space's own: ldap-rest and the other apps still hold an archived space,
// or one in the Bin.
export const spaceState = pgEnum('space_state', [
  'active',
  'archived',
  'trashed'
])

export const spaces = pgTable(
  'spaces',
  {
    spaceId: uuid('space_id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    name: text().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    state: spaceState().notNull().default('active'),
    // The lowercased email of the person who created it, when known.
    createdBy: text('created_by')
  },
  table => [index().on(table.organizationId)]
)

// Every space has a feed, so it is no tab to pick.
export const spaceTab = pgEnum('space_tab', [
  'chat',
  'tasks',
  'drive',
  'mail',
  'calendar'
])

// What the creator picked in twake-space; ldap-rest does not hold it. A space
// without a row was created elsewhere and has every tab on.
export const spaceSettings = pgTable('space_settings', {
  spaceId: uuid('space_id').primaryKey(),
  description: text().notNull().default(''),
  color: text(),
  apps: spaceTab().array().notNull()
})

// Apart from the settings, so that reading a space does not read the image.
export const spaceBanners = pgTable('space_banners', {
  spaceId: uuid('space_id').primaryKey(),
  contentType: text('content_type').notNull(),
  image: bytea().notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow()
})

// The tables below have no foreign key to spaces: they are fed by events that can be
// consumed before the space event.

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id').notNull(),
    // The LDAP entryUUID: a username or an email can change.
    userId: uuid('user_id').notNull(),
    username: text().notNull(),
    email: text().notNull(),
    displayName: text('display_name'),
    role: spaceRole().notNull()
  },
  table => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index().on(table.userId)
  ]
)

export const spaceGroups = pgTable(
  'space_groups',
  {
    spaceId: uuid('space_id').notNull(),
    groupId: uuid('group_id').notNull(),
    name: text().notNull(),
    role: spaceRole().notNull()
  },
  table => [
    primaryKey({ columns: [table.spaceId, table.groupId] }),
    index().on(table.groupId)
  ]
)

// The newest name of a group, kept even while no space links it, so a link older
// than a rename takes the new name.
export const groupNames = pgTable('group_names', {
  groupId: uuid('group_id').primaryKey(),
  name: text().notNull(),
  renamedAt: timestamptz('renamed_at').notNull()
})

export const organizationRole = pgEnum('organization_role', [
  'owner',
  'admin',
  'moderator',
  'member'
])

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: text('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    email: text().notNull(),
    role: organizationRole().notNull()
  },
  table => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index().on(table.userId)
  ]
)

export const spaceReconciliations = pgTable('space_reconciliations', {
  organizationId: text('organization_id').primaryKey(),
  ranAt: timestamptz('ran_at').notNull()
})

export const spaceResourceKind = pgEnum('space_resource_kind', [
  'drive',
  'mailbox',
  'calendar',
  'matrix_space',
  'project'
])

export const spaceResources = pgTable(
  'space_resources',
  {
    spaceId: uuid('space_id').notNull(),
    kind: spaceResourceKind().notNull(),
    organizationId: text('organization_id').notNull(),
    resourceId: text('resource_id').notNull(),
    provisionedAt: timestamptz('provisioned_at').notNull().defaultNow()
  },
  table => [
    primaryKey({ columns: [table.spaceId, table.kind] }),
    index().on(table.kind, table.resourceId)
  ]
)

// What a member did with a space: pinned it, opened it last.
export const spaceMarks = pgTable(
  'space_marks',
  {
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    pinnedAt: timestamptz('pinned_at'),
    openedAt: timestamptz('opened_at')
  },
  table => [primaryKey({ columns: [table.spaceId, table.userId] })]
)
