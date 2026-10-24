import type { SpaceRole } from '@/application/spaces'

export const TOKEN_SCOPES = [
  'space:read',
  'space:write',
  'members:write',
  'feed:read',
  'feed:write',
  'tokens:write',
  'notifications:read'
] as const

export type TokenScope = (typeof TOKEN_SCOPES)[number]

export type AccessLevel = 'none' | 'read' | 'write'

// One access level per resource, where write includes read.
export const RESOURCE_SCOPES = {
  spaces: { read: ['space:read'], write: ['space:read', 'space:write'] },
  feed: { read: ['feed:read'], write: ['feed:read', 'feed:write'] },
  members: { write: ['members:write'] },
  notifications: { read: ['notifications:read'] },
  tokens: { write: ['tokens:write'] }
} as const satisfies Record<
  string,
  Partial<Record<Exclude<AccessLevel, 'none'>, readonly TokenScope[]>>
>

export type TokenResource = keyof typeof RESOURCE_SCOPES

export const TOKEN_RESOURCES = Object.keys(RESOURCE_SCOPES) as TokenResource[]

/** An organization token acts for no one, so it has no notifications. */
export function tokenResources(owner: TokenOwner): TokenResource[] {
  return owner === 'organization'
    ? TOKEN_RESOURCES.filter(resource => resource !== 'notifications')
    : TOKEN_RESOURCES
}

export type TokenAccess = Record<TokenResource, AccessLevel>

export function accessLevels(resource: TokenResource): AccessLevel[] {
  return ['none', ...(Object.keys(RESOURCE_SCOPES[resource]) as AccessLevel[])]
}

export function scopesOf(access: TokenAccess): TokenScope[] {
  return TOKEN_RESOURCES.flatMap(resource => {
    const level = access[resource]
    const levels: Partial<Record<AccessLevel, readonly TokenScope[]>> =
      RESOURCE_SCOPES[resource]
    return [...(levels[level] ?? [])]
  })
}

/** The backend routes each scope opens to a token. */
export const SCOPE_ROUTES: Record<TokenScope, string[]> = {
  'space:read': ['GET /spaces', 'GET /spaces/apps', 'GET /spaces/:id'],
  'space:write': [
    'POST /spaces',
    'PATCH /spaces/:id',
    'PUT /spaces/:id/state',
    'DELETE /spaces/:id',
    'DELETE /spaces/bin'
  ],
  'members:write': [
    'GET /organization/members',
    'GET /organization/groups',
    'POST /spaces/:id/members',
    'PATCH, DELETE /spaces/:id/members/:userId',
    'POST /spaces/:id/groups',
    'PATCH, DELETE /spaces/:id/groups/:groupId'
  ],
  'feed:read': [
    'GET /spaces/:spaceId/feed',
    'GET /spaces/:spaceId/feed/items/:itemId'
  ],
  'feed:write': [
    'POST /spaces/:spaceId/feed/posts',
    'PATCH, DELETE /spaces/:spaceId/feed/posts/:itemId'
  ],
  'tokens:write': [
    'GET, POST /tokens',
    'PATCH, DELETE /tokens/:id',
    'GET /organization/token-policy'
  ],
  'notifications:read': ['GET /notifications']
}

/** Personal tokens act for the caller; organization tokens need an org admin. */
export type TokenOwner = 'personal' | 'organization'

export const TOKEN_LIFETIMES = [7, 30, 90, 365] as const

export type TokenLifetime = (typeof TOKEN_LIFETIMES)[number]

export interface ApiToken {
  id: string
  name: string
  scopes: TokenScope[]
  spaces: 'all' | string[]
  /** The role an organization token holds in its spaces; null otherwise. */
  role: SpaceRole | null
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface NewToken {
  name: string
  scopes: TokenScope[]
  spaces: 'all' | string[]
  /** Required for an organization token, refused for a personal one. */
  role?: SpaceRole
  /** Null for a token that never expires, when the policy allows it. */
  expiresInDays: TokenLifetime | null
}

/** The secret is only ever shown in the answer to its creation. */
export interface CreatedToken {
  id: string
  name: string
  token: string
  scopes: TokenScope[]
  spaces: 'all' | string[]
  role: SpaceRole | null
  expiresAt: string | null
}

export interface TokenPolicy {
  allowNoExpiry: boolean
  maxLifetimeDays: number | null
}

export function allowedLifetimes(
  policy: TokenPolicy
): (TokenLifetime | null)[] {
  const { maxLifetimeDays } = policy
  return [
    ...TOKEN_LIFETIMES.filter(
      days => maxLifetimeDays === null || days <= maxLifetimeDays
    ),
    ...(policy.allowNoExpiry ? [null] : [])
  ]
}

export interface TokenSpace {
  id: string
  name: string
}

export const API_REFERENCE_URL =
  'https://github.com/linagora/twake-space/blob/main/docs/api.md'

export function curlExample(apiUrl: string, token: string): string {
  return `curl -H "Authorization: Bearer ${token}" ${apiUrl.replace(/\/?$/, '/spaces')}`
}

// English on purpose: it is pasted into an agent's instructions, not read in
// the page.
export function agentBrief(apiUrl: string, created: CreatedToken): string {
  return [
    `You can call the Twake Space API at ${apiUrl}`,
    `Send every request with the header "Authorization: Bearer ${created.token}". Requests and answers are JSON.`,
    created.spaces === 'all'
      ? created.role === null
        ? 'The token reaches every space its account is a member of.'
        : `The token reaches every space of the organization, as ${created.role}.`
      : `The token reaches ${String(created.spaces.length)} space(s)${created.role === null ? '' : `, as ${created.role}`}; any other space answers 404.`,
    'It may call:',
    '- GET /tokens/self, which describes the token: its scopes, spaces and expiry',
    ...created.scopes.flatMap(scope =>
      SCOPE_ROUTES[scope].map(route => `- ${route}`)
    ),
    'Any other route answers 403 insufficient_scope.',
    ...(created.scopes.includes('feed:write')
      ? [`Posts are signed "${created.name}", never as a person.`]
      : []),
    `Full reference: ${API_REFERENCE_URL}`
  ].join('\n')
}

export interface TokensService {
  list: (owner: TokenOwner) => Promise<ApiToken[]>
  create: (owner: TokenOwner, token: NewToken) => Promise<CreatedToken>
  rename: (owner: TokenOwner, id: string, name: string) => Promise<void>
  revoke: (owner: TokenOwner, id: string) => Promise<void>
  policy: () => Promise<TokenPolicy>
  /** Every space of the organization, for an organization admin. */
  organizationSpaces: () => Promise<TokenSpace[]>
}
