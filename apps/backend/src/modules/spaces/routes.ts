import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import type { Authorize, Caller } from '../auth/index.ts'
import { homeservers, organizations } from '../organizations/schema.ts'
import { liveOrganizationRole } from './managers.ts'
import { APP_KINDS, type SpaceApp } from './resources.ts'
import {
  organizationMembers,
  spaceBanners,
  spaceGroups,
  spaceMarks,
  spaceMembers,
  spaceResourceKind,
  spaceResources,
  spaceRole,
  spaceSettings,
  spaceTab,
  spaces
} from './schema.ts'
import type { Workplaces } from './workplaces.ts'

type SpaceRole = (typeof spaceRole.enumValues)[number]

const spaceParams = z.object({ id: z.uuid() })
const listQuery = z.object({
  state: z.enum(['archived', 'trashed']).optional()
})

const coveredBy = (caller: Caller) =>
  and(
    eq(spaces.organizationId, caller.organizationId),
    caller.kind === 'token' && caller.spaceIds
      ? inArray(spaces.spaceId, caller.spaceIds)
      : undefined
  )

// The managers of a space: its admins, the organization's owners and admins,
// and the person who created it. An organization token acting as an admin
// manages the spaces it covers.
export function managedBy(caller: Caller): SQL {
  const { userId } = caller
  if (userId === null) {
    return caller.kind === 'token' && caller.role === 'admin'
      ? sql`true`
      : sql`false`
  }
  const email = caller.kind === 'session' ? caller.email.toLowerCase() : null
  return sql`(exists (select 1 from ${spaceMembers}
      where ${spaceMembers.spaceId} = ${spaces.spaceId}
      and ${spaceMembers.userId} = ${userId} and ${spaceMembers.role} = 'admin')
    or exists (select 1 from ${organizationMembers}
      where ${organizationMembers.organizationId} = ${spaces.organizationId}
      and ${organizationMembers.userId} = ${userId}
      and ${organizationMembers.role} in ('owner', 'admin'))
    or ${spaces.createdBy} = ${email}
    or ${spaces.createdBy} in (select lower(${organizationMembers.email})
      from ${organizationMembers}
      where ${organizationMembers.organizationId} = ${spaces.organizationId}
      and ${organizationMembers.userId} = ${userId}))`
}

// The spaces a caller manages, whatever their state, with its role in each
// when it is a member.
export function managedSpaces(db: Db, caller: Caller, where?: SQL) {
  const { userId } = caller
  return db
    .select({
      id: spaces.spaceId,
      name: spaces.name,
      state: spaces.state,
      color: spaceSettings.color,
      description: spaceSettings.description,
      role:
        userId === null
          ? sql<SpaceRole | null>`${caller.kind === 'token' ? caller.role : null}`
          : sql<SpaceRole | null>`(select ${spaceMembers.role} from ${spaceMembers}
              where ${spaceMembers.spaceId} = ${spaces.spaceId}
              and ${spaceMembers.userId} = ${userId})`
    })
    .from(spaces)
    .leftJoin(spaceSettings, eq(spaceSettings.spaceId, spaces.spaceId))
    .where(and(coveredBy(caller), managedBy(caller), where))
    .orderBy(asc(spaces.name))
}

// The active spaces a caller reaches, with the role it acts with in each: its
// account's membership, or an organization token's own role on every space it
// covers.
export function reachableSpaces(db: Db, caller: Caller, spaceId?: string) {
  const covered = and(
    coveredBy(caller),
    eq(spaces.state, 'active'),
    spaceId === undefined ? undefined : eq(spaces.spaceId, spaceId)
  )
  const fields = {
    id: spaces.spaceId,
    name: spaces.name,
    createdAt: spaces.createdAt,
    color: spaceSettings.color,
    description: spaceSettings.description,
    apps: spaceSettings.apps
  }
  const settings = eq(spaceSettings.spaceId, spaces.spaceId)
  const { userId } = caller
  if (userId === null) {
    const role = caller.kind === 'token' ? caller.role : null
    if (!role) throw new Error('an organization token has no role')
    return db
      .select(fields)
      .from(spaces)
      .leftJoin(spaceSettings, settings)
      .where(covered)
      .orderBy(asc(spaces.name))
      .then(rows =>
        rows.map(row => ({ ...row, role, pinnedAt: null, openedAt: null }))
      )
  }
  return db
    .select({
      ...fields,
      role: spaceMembers.role,
      pinnedAt: spaceMarks.pinnedAt,
      openedAt: spaceMarks.openedAt
    })
    .from(spaces)
    .innerJoin(
      spaceMembers,
      and(
        eq(spaceMembers.spaceId, spaces.spaceId),
        eq(spaceMembers.userId, userId)
      )
    )
    .leftJoin(spaceSettings, settings)
    .leftJoin(
      spaceMarks,
      and(eq(spaceMarks.spaceId, spaces.spaceId), eq(spaceMarks.userId, userId))
    )
    .where(covered)
    .orderBy(asc(spaces.name))
}

function callerOf(request: FastifyRequest) {
  if (!request.caller) throw new Error('authorize let a request through')
  return request.caller
}

export function registerSpaceRoutes(
  app: HttpServer,
  deps: {
    db: Db
    authorize: Authorize
    apps: readonly SpaceApp[]
    workplaces: Workplaces
    organizationDirectory: Pick<Directory, 'organizationRole'>
  }
) {
  const { db, authorize, workplaces, organizationDirectory } = deps
  const provided = new Set(deps.apps.map(app => APP_KINDS[app]))

  async function withManages<T extends { id: string }>(
    caller: Caller,
    reached: T[]
  ) {
    const managed =
      reached.length === 0
        ? []
        : await db
            .select({ id: spaces.spaceId })
            .from(spaces)
            .where(
              and(
                inArray(
                  spaces.spaceId,
                  reached.map(space => space.id)
                ),
                managedBy(caller)
              )
            )
    const ids = new Set(managed.map(space => space.id))
    return reached.map(space => ({ ...space, manages: ids.has(space.id) }))
  }

  app.get(
    '/spaces',
    { preHandler: authorize('space:read') },
    async (request, reply) => {
      const caller = callerOf(request)
      const query = listQuery.safeParse(request.query)
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const { state } = query.data
      // The archives and the Bin list spaces the caller need not be in.
      if (state) await liveOrganizationRole(db, organizationDirectory, caller)
      const reached = state
        ? (await managedSpaces(db, caller, eq(spaces.state, state))).map(
            space => ({
              ...space,
              pinnedAt: null,
              openedAt: null,
              manages: true
            })
          )
        : await withManages(caller, await reachableSpaces(db, caller))
      // The home cards show who is in each space.
      const members =
        reached.length === 0
          ? []
          : await db
              .select({
                spaceId: spaceMembers.spaceId,
                id: spaceMembers.userId,
                username: spaceMembers.username,
                displayName: spaceMembers.displayName
              })
              .from(spaceMembers)
              .where(
                inArray(
                  spaceMembers.spaceId,
                  reached.map(space => space.id)
                )
              )
              .orderBy(asc(spaceMembers.username))
      const fqdns = await workplaces(
        caller.organizationId,
        members.map(member => member.id)
      )
      return {
        spaces: reached.map(
          ({
            id,
            name,
            role,
            color,
            description,
            pinnedAt,
            openedAt,
            manages
          }) => ({
            id,
            name,
            role,
            color,
            description: description ?? '',
            pinnedAt,
            openedAt,
            manages,
            members: members
              .filter(member => member.spaceId === id)
              .map(({ id, username, displayName }) => ({
                id,
                username,
                displayName,
                workplaceFqdn: fqdns.get(id) ?? null
              }))
          })
        )
      }
    }
  )

  app.get(
    '/spaces/apps',
    { preHandler: authorize('space:read') },
    async request => {
      const [organization] = await db
        .select({
          chat: organizations.chatAvailable,
          mail: organizations.mailAvailable
        })
        .from(organizations)
        .where(
          eq(organizations.organizationId, callerOf(request).organizationId)
        )
      const on = new Set(
        deps.apps.filter(
          app =>
            (app !== 'chat' || organization?.chat) &&
            (app !== 'mail' || organization?.mail)
        )
      )
      return {
        apps: spaceTab.enumValues.filter(tab => on.has(tab))
      }
    }
  )

  app.get(
    '/spaces/:id',
    { preHandler: authorize('space:read') },
    async (request, reply) => {
      const params = spaceParams.safeParse(request.params)
      if (!params.success) return reply.code(404).send({ error: 'not_found' })
      const spaceId = params.data.id
      const caller = callerOf(request)

      const [space] = await withManages(
        caller,
        await reachableSpaces(db, caller, spaceId)
      )
      if (!space) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const [members, groups, resources, [organization], [banner]] =
        await Promise.all([
          db
            .select({
              id: spaceMembers.userId,
              username: spaceMembers.username,
              email: spaceMembers.email,
              displayName: spaceMembers.displayName,
              role: spaceMembers.role
            })
            .from(spaceMembers)
            .where(eq(spaceMembers.spaceId, spaceId))
            .orderBy(asc(spaceMembers.username)),
          db
            .select({
              id: spaceGroups.groupId,
              name: spaceGroups.name,
              role: spaceGroups.role
            })
            .from(spaceGroups)
            .where(eq(spaceGroups.spaceId, spaceId))
            .orderBy(asc(spaceGroups.name)),
          db
            .select({
              kind: spaceResources.kind,
              id: spaceResources.resourceId
            })
            .from(spaceResources)
            .where(eq(spaceResources.spaceId, spaceId)),
          db
            .select({
              chat: organizations.chatAvailable,
              mail: organizations.mailAvailable,
              homeserverUrl: homeservers.url,
              chatUrl: homeservers.chatUrl
            })
            .from(organizations)
            .leftJoin(
              homeservers,
              eq(homeservers.id, organizations.homeserverId)
            )
            .where(
              eq(organizations.organizationId, callerOf(request).organizationId)
            ),
          db
            .select({ updatedAt: spaceBanners.updatedAt })
            .from(spaceBanners)
            .where(eq(spaceBanners.spaceId, spaceId))
        ])
      const resourceIds = new Map(resources.map(r => [r.kind, r.id]))
      const fqdns = await workplaces(
        callerOf(request).organizationId,
        members.map(member => member.id)
      )

      return {
        ...space,
        description: space.description ?? '',
        apps: space.apps ?? spaceTab.enumValues,
        chat: organization?.chat ?? false,
        mail: organization?.mail ?? false,
        homeserverUrl: organization?.homeserverUrl ?? null,
        chatUrl: organization?.chatUrl ?? null,
        // Changes with the image, so that a client can tell it needs the new one.
        banner: banner?.updatedAt.toISOString() ?? null,
        members: members.map(member => ({
          ...member,
          workplaceFqdn: fqdns.get(member.id) ?? null
        })),
        groups,
        // A kind without an id is still being prepared by its app.
        resources: spaceResourceKind.enumValues
          .filter(kind => provided.has(kind))
          .map(kind => ({ kind, id: resourceIds.get(kind) ?? null }))
      }
    }
  )

  app.get(
    '/spaces/:id/banner',
    { preHandler: authorize('space:read') },
    async (request, reply) => {
      const params = spaceParams.safeParse(request.params)
      if (!params.success) return reply.code(404).send({ error: 'not_found' })
      const spaceId = params.data.id
      const [space] = await reachableSpaces(db, callerOf(request), spaceId)
      const [banner] = space
        ? await db
            .select({
              contentType: spaceBanners.contentType,
              image: spaceBanners.image
            })
            .from(spaceBanners)
            .where(eq(spaceBanners.spaceId, spaceId))
        : []
      if (!banner) return reply.code(404).send({ error: 'not_found' })
      return reply
        .header('content-type', banner.contentType)
        .header('cache-control', 'private, no-cache')
        .header('x-content-type-options', 'nosniff')
        .send(banner.image)
    }
  )

  // Marks are a person's own: no token sets them.
  const own = { preHandler: authorize() }
  const mark =
    (change: () => { pinnedAt?: Date | null; openedAt?: Date }) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = callerOf(request)
      if (caller.kind !== 'session') {
        throw new Error('authorize let a request through')
      }
      const params = spaceParams.safeParse(request.params)
      if (!params.success) return reply.code(404).send({ error: 'not_found' })
      const [space] = await reachableSpaces(db, caller, params.data.id)
      if (!space) return reply.code(404).send({ error: 'not_found' })
      const set = change()
      await db
        .insert(spaceMarks)
        .values({ spaceId: space.id, userId: caller.userId, ...set })
        .onConflictDoUpdate({
          target: [spaceMarks.spaceId, spaceMarks.userId],
          set
        })
      return reply.code(204).send()
    }

  app.put(
    '/spaces/:id/pin',
    own,
    mark(() => ({ pinnedAt: new Date() }))
  )
  app.delete(
    '/spaces/:id/pin',
    own,
    mark(() => ({ pinnedAt: null }))
  )
  app.put(
    '/spaces/:id/opened',
    own,
    mark(() => ({ openedAt: new Date() }))
  )
}
