import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import { sha256 } from '../auth/authenticator.ts'
import { perHour, type Authorize, type Caller } from '../auth/index.ts'
import { liveOrganizationRole } from '../spaces/managers.ts'
import { spaceMembers, spaceRole, spaces } from '../spaces/schema.ts'
import { API_TOKEN_PREFIX, type Scope } from './authenticator.ts'
import { revokeTokens } from './revocation.ts'
import {
  apiTokens,
  apiTokenSpaces,
  organizationTokenPolicy,
  tokenAudit,
  tokenScope
} from './schema.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIFETIME_DAYS = 30

const name = z.string().trim().min(1).max(100)

const createBody = z
  .object({
    name,
    scopes: z.array(z.enum(tokenScope.enumValues)).min(1),
    spaces: z.union([z.literal('all'), z.array(z.uuid()).min(1)]),
    role: z.enum(spaceRole.enumValues).optional(),
    expiresInDays: z.literal([7, 30, 90, 365]).optional(),
    // Null for a token that never expires.
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional()
  })
  .refine(
    body => body.expiresInDays === undefined || body.expiresAt === undefined,
    'expiresInDays or expiresAt, not both'
  )

const tokenParams = z.object({ id: z.uuid() })

const policyBody = z.object({
  allowNoExpiry: z.boolean(),
  maxLifetimeDays: z.int().positive().max(3650).nullable()
})

const AUDIT_PAGE = 500

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message })
}

function forbidden(reply: FastifyReply, message: string) {
  return reply.code(403).send({ error: 'forbidden', message })
}

function callerOf(request: FastifyRequest): Caller {
  if (!request.caller) throw new Error('authorize let a request through')
  return request.caller
}

// The tokens a caller manages under one route prefix.
interface Manager {
  caller: Caller
  // Who the audit log names.
  actor: string
  owner:
    | { ownerKind: 'account'; accountId: string; technical: boolean }
    | { ownerKind: 'organization' }
  owns: SQL | undefined
  // The spaces among `spaceIds` that a new token may cover.
  coverable: (spaceIds: string[]) => Promise<string[]>
}

type Manage = (request: FastifyRequest, db: Db) => Promise<Manager | string>

const actorOf = (caller: Caller) =>
  caller.kind === 'session' ? caller.userId : `token:${caller.tokenId}`

function accountManager(
  db: Db,
  caller: Caller,
  accountId: string,
  technical: boolean
): Manager {
  return {
    caller,
    actor: actorOf(caller),
    owner: { ownerKind: 'account', accountId, technical },
    owns: and(
      eq(apiTokens.organizationId, caller.organizationId),
      eq(apiTokens.accountId, accountId)
    ),
    coverable: async spaceIds =>
      (
        await db
          .select({ spaceId: spaceMembers.spaceId })
          .from(spaceMembers)
          .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
          .where(
            and(
              eq(spaceMembers.userId, accountId),
              eq(spaces.organizationId, caller.organizationId),
              inArray(spaceMembers.spaceId, spaceIds)
            )
          )
      ).map(s => s.spaceId)
  }
}

const manageOwnAccount: Manage = (request, db) => {
  const caller = callerOf(request)
  const { userId } = caller
  if (userId === null) return Promise.resolve('not an account token')
  const technical = caller.kind === 'token' && caller.technical
  return Promise.resolve(accountManager(db, caller, userId, technical))
}

const accountParams = z.object({ accountId: z.uuid() })

function manageTechnicalAccount(
  directory: Pick<Directory, 'isTechnicalAccount'>,
  manageOrganization: Manage
): Manage {
  return async (request, db) => {
    const admin = await manageOrganization(request, db)
    if (typeof admin === 'string') return admin
    const params = accountParams.safeParse(request.params)
    if (
      !params.success ||
      !(await directory.isTechnicalAccount(
        admin.caller.organizationId,
        params.data.accountId
      ))
    ) {
      return 'not a technical account of the organization'
    }
    return accountManager(db, admin.caller, params.data.accountId, true)
  }
}

const ADMIN_ROLES: readonly string[] = ['owner', 'admin']

async function isOrganizationAdmin(
  db: Db,
  directory: Pick<Directory, 'organizationRole'>,
  organizationId: string,
  userId: string
) {
  const role = await liveOrganizationRole(db, directory, {
    organizationId,
    userId
  })
  return role !== undefined && ADMIN_ROLES.includes(role)
}

const organizationManager =
  (directory: Pick<Directory, 'organizationRole'>): Manage =>
  async (request, db) => {
    const caller = callerOf(request)
    // A token would reach every space of the organization through the tokens
    // it creates, far beyond its own account's spaces.
    if (caller.kind === 'token') {
      return 'the organization tokens are managed from a signed-in session'
    }
    const { userId, organizationId } = caller
    if (!(await isOrganizationAdmin(db, directory, organizationId, userId))) {
      return 'not an admin of the organization'
    }
    return {
      caller,
      actor: actorOf(caller),
      owner: { ownerKind: 'organization' },
      owns: and(
        eq(apiTokens.organizationId, organizationId),
        eq(apiTokens.ownerKind, 'organization')
      ),
      coverable: async spaceIds =>
        (
          await db
            .select({ spaceId: spaces.spaceId })
            .from(spaces)
            .where(
              and(
                eq(spaces.organizationId, organizationId),
                inArray(spaces.spaceId, spaceIds)
              )
            )
        ).map(s => s.spaceId)
    }
  }

// Null when the organization's policy allows the expiry, else why not.
async function refusedExpiry(
  db: Db,
  organizationId: string,
  expiresAt: Date | null,
  now: number
): Promise<string | null> {
  if (expiresAt && expiresAt.getTime() <= now) return 'expiresAt is in the past'
  const [policy] = await db
    .select()
    .from(organizationTokenPolicy)
    .where(eq(organizationTokenPolicy.organizationId, organizationId))
  if (expiresAt === null && !policy?.allowNoExpiry) {
    return 'the organization requires an expiry'
  }
  if (
    expiresAt &&
    policy?.maxLifetimeDays &&
    expiresAt.getTime() > now + policy.maxLifetimeDays * DAY_MS
  ) {
    return `the organization caps tokens at ${String(policy.maxLifetimeDays)} days`
  }
  return null
}

function exceeds(
  caller: Caller,
  scopes: Scope[],
  spaceIds: string[] | null,
  expiresAt: Date | null
): boolean {
  if (caller.kind !== 'token') return false
  const covered = caller.spaceIds
  return (
    !scopes.every(s => caller.scopes.includes(s)) ||
    (covered !== null &&
      (!spaceIds || !spaceIds.every(s => covered.includes(s)))) ||
    (caller.expiresAt !== null && (!expiresAt || expiresAt > caller.expiresAt))
  )
}

function registerManagedTokens(
  app: HttpServer,
  db: Db,
  prefix: string,
  preHandler: ReturnType<Authorize>,
  manage: Manage
) {
  const create = { preHandler, config: { limit: perHour(20) } }
  app.post(prefix, create, async (request, reply) => {
    const manager = await manage(request, db)
    if (typeof manager === 'string') return forbidden(reply, manager)
    const { caller, actor } = manager
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return invalid(reply, z.prettifyError(parsed.error))
    const body = parsed.data
    const forOrganization = manager.owner.ownerKind === 'organization'
    if (forOrganization !== (body.role !== undefined)) {
      return invalid(
        reply,
        forOrganization
          ? 'an organization token needs a role'
          : 'only an organization token has a role'
      )
    }

    const now = Date.now()
    const expiresAt =
      body.expiresAt === null
        ? null
        : body.expiresAt
          ? new Date(body.expiresAt)
          : new Date(
              now + (body.expiresInDays ?? DEFAULT_LIFETIME_DAYS) * DAY_MS
            )
    const refused = await refusedExpiry(
      db,
      caller.organizationId,
      expiresAt,
      now
    )
    if (refused) return invalid(reply, refused)

    const scopes = [...new Set(body.scopes)]
    if (
      scopes.includes('notifications:write') &&
      !(manager.owner.ownerKind === 'account' && manager.owner.technical)
    ) {
      return forbidden(reply, 'notifications:write is for technical accounts')
    }
    if (
      scopes.includes('notifications:read') &&
      manager.owner.ownerKind === 'organization'
    ) {
      return forbidden(reply, 'notifications:read is for account tokens')
    }
    if (scopes.includes('feed:write') && body.role === 'viewer') {
      return invalid(reply, 'a viewer posts nothing: feed:write needs editor')
    }
    const spaceIds = body.spaces === 'all' ? null : [...new Set(body.spaces)]
    if (
      spaceIds &&
      (await manager.coverable(spaceIds)).length !== spaceIds.length
    ) {
      return invalid(reply, 'spaces must be spaces the owner can reach')
    }
    if (exceeds(caller, scopes, spaceIds, expiresAt)) {
      return forbidden(reply, 'more rights than the token creating it')
    }

    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const id = await db.transaction(async tx => {
      const [row] = await tx
        .insert(apiTokens)
        .values({
          organizationId: caller.organizationId,
          ...manager.owner,
          role: body.role,
          name: body.name,
          tokenHash: sha256(token),
          scopes,
          allSpaces: spaceIds === null,
          expiresAt,
          createdBy: actor,
          parentTokenId: caller.kind === 'token' ? caller.tokenId : null
        })
        .returning({ id: apiTokens.id })
      if (!row) throw new Error('insert returned no row')
      if (spaceIds) {
        await tx
          .insert(apiTokenSpaces)
          .values(spaceIds.map(spaceId => ({ tokenId: row.id, spaceId })))
      }
      await tx
        .insert(tokenAudit)
        .values({ tokenId: row.id, action: 'created', actor })
      return row.id
    })
    return reply.code(201).send({
      id,
      name: body.name,
      token,
      scopes,
      spaces: spaceIds ?? 'all',
      role: body.role ?? null,
      expiresAt
    })
  })

  app.get(prefix, { preHandler }, async (request, reply) => {
    const manager = await manage(request, db)
    if (typeof manager === 'string') return forbidden(reply, manager)
    const rows = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scopes: apiTokens.scopes,
        allSpaces: apiTokens.allSpaces,
        role: apiTokens.role,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt
      })
      .from(apiTokens)
      .where(and(manager.owns, isNull(apiTokens.revokedAt)))
      .orderBy(asc(apiTokens.createdAt))
    const covered = await db
      .select()
      .from(apiTokenSpaces)
      .where(
        inArray(
          apiTokenSpaces.tokenId,
          rows.map(r => r.id)
        )
      )
    return {
      tokens: rows.map(({ allSpaces, ...row }) => ({
        ...row,
        spaces: allSpaces
          ? 'all'
          : covered.filter(c => c.tokenId === row.id).map(c => c.spaceId)
      }))
    }
  })

  // An active token the caller manages, or nothing.
  const managedToken = async (request: FastifyRequest) => {
    const manager = await manage(request, db)
    const params = tokenParams.safeParse(request.params)
    if (typeof manager === 'string' || !params.success) return null
    return {
      actor: manager.actor,
      where: and(
        eq(apiTokens.id, params.data.id),
        manager.owns,
        isNull(apiTokens.revokedAt)
      )
    }
  }

  app.patch(`${prefix}/:id`, { preHandler }, async (request, reply) => {
    const target = await managedToken(request)
    if (!target) return reply.code(404).send({ error: 'not_found' })
    const parsed = z.object({ name }).safeParse(request.body)
    if (!parsed.success) return invalid(reply, z.prettifyError(parsed.error))
    const renamed = await db.transaction(async tx => {
      const [row] = await tx
        .update(apiTokens)
        .set({ name: parsed.data.name })
        .where(target.where)
        .returning({ id: apiTokens.id })
      if (row) {
        await tx
          .insert(tokenAudit)
          .values({ tokenId: row.id, action: 'renamed', actor: target.actor })
      }
      return row
    })
    if (!renamed) return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })

  app.delete(`${prefix}/:id`, { preHandler }, async (request, reply) => {
    const target = await managedToken(request)
    if (!target) return reply.code(404).send({ error: 'not_found' })
    const revoked = await db.transaction(tx =>
      revokeTokens(tx, target.where, {
        actor: target.actor,
        reason: 'revoked by hand'
      })
    )
    if (revoked.length === 0)
      return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
}

export function registerTokenRoutes(
  app: HttpServer,
  deps: {
    db: Db
    authorize: Authorize
    directory: Pick<Directory, 'isTechnicalAccount' | 'organizationRole'>
  }
) {
  const { db } = deps
  const preHandler = deps.authorize('tokens:write')
  const manageOrganization = organizationManager(deps.directory)

  // Any token may read itself, so a client learns what it was given before a
  // route refuses it, and when it expires.
  app.get(
    '/tokens/self',
    { preHandler: deps.authorize('any') },
    (request, reply) => {
      const caller = callerOf(request)
      if (caller.kind !== 'token') {
        return forbidden(reply, 'not an API token')
      }
      return {
        id: caller.tokenId,
        name: caller.name,
        owner:
          caller.userId === null
            ? 'organization'
            : caller.technical
              ? 'technical_account'
              : 'account',
        accountId: caller.userId,
        organizationId: caller.organizationId,
        scopes: caller.scopes,
        spaces: caller.spaceIds ?? 'all',
        role: caller.role,
        expiresAt: caller.expiresAt
      }
    }
  )

  registerManagedTokens(app, db, '/tokens', preHandler, manageOwnAccount)
  registerManagedTokens(
    app,
    db,
    '/organization/tokens',
    preHandler,
    manageOrganization
  )
  registerManagedTokens(
    app,
    db,
    '/organization/technical-accounts/:accountId/tokens',
    preHandler,
    manageTechnicalAccount(deps.directory, manageOrganization)
  )

  // Not only admins: a client offers only the lifetimes it allows.
  app.get('/organization/token-policy', { preHandler }, async request => {
    const [policy] = await db
      .select({
        allowNoExpiry: organizationTokenPolicy.allowNoExpiry,
        maxLifetimeDays: organizationTokenPolicy.maxLifetimeDays
      })
      .from(organizationTokenPolicy)
      .where(
        eq(
          organizationTokenPolicy.organizationId,
          callerOf(request).organizationId
        )
      )
    return policy ?? { allowNoExpiry: false, maxLifetimeDays: null }
  })

  // The spaces an organization token may cover, members or not.
  app.get(
    '/organization/token-spaces',
    { preHandler },
    async (request, reply) => {
      const manager = await manageOrganization(request, db)
      if (typeof manager === 'string') return forbidden(reply, manager)
      return {
        spaces: await db
          .select({ id: spaces.spaceId, name: spaces.name })
          .from(spaces)
          .where(eq(spaces.organizationId, manager.caller.organizationId))
          .orderBy(asc(spaces.name))
      }
    }
  )

  app.put(
    '/organization/token-policy',
    { preHandler },
    async (request, reply) => {
      const manager = await manageOrganization(request, db)
      if (typeof manager === 'string') return forbidden(reply, manager)
      const parsed = policyBody.safeParse(request.body)
      if (!parsed.success) return invalid(reply, z.prettifyError(parsed.error))
      await db
        .insert(organizationTokenPolicy)
        .values({
          organizationId: manager.caller.organizationId,
          ...parsed.data
        })
        .onConflictDoUpdate({
          target: organizationTokenPolicy.organizationId,
          set: parsed.data
        })
      return reply.code(204).send()
    }
  )

  app.get(
    '/organization/token-audit',
    { preHandler },
    async (request, reply) => {
      const manager = await manageOrganization(request, db)
      if (typeof manager === 'string') return forbidden(reply, manager)
      const entries = await db
        .select({
          tokenId: tokenAudit.tokenId,
          tokenName: apiTokens.name,
          action: tokenAudit.action,
          actor: tokenAudit.actor,
          at: tokenAudit.at,
          reason: tokenAudit.reason
        })
        .from(tokenAudit)
        .innerJoin(apiTokens, eq(apiTokens.id, tokenAudit.tokenId))
        .where(eq(apiTokens.organizationId, manager.caller.organizationId))
        .orderBy(desc(tokenAudit.at))
        .limit(AUDIT_PAGE)
      return { entries }
    }
  )
}
