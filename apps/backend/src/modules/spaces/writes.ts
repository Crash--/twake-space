import { LdapRestError } from '@linagora/ldap-rest-client'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db, Tx } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { SpaceDirectory, SpaceRole } from '../../infra/ldap-rest.ts'
import type { Authorize, Caller } from '../auth/index.ts'
import { tell, tellSpaceMembers } from '../live/notify.ts'
import {
  createSpace,
  deleteSpace,
  removeSpaceMembers,
  renameSpace,
  unlinkGroups,
  upsertGroups,
  upsertMembers
} from './events.ts'
import { managedSpaces, reachableSpaces } from './routes.ts'
import {
  organizationMembers,
  spaceBanners,
  spaceMembers,
  spaceRole,
  spaceSettings,
  spaceState,
  spaceTab,
  spaces
} from './schema.ts'

const role = z.enum(spaceRole.enumValues)
const name = z.string().trim().min(1).max(255)
const spaceParams = z.object({ id: z.uuid() })
const memberParams = spaceParams.extend({ userId: z.uuid() })
const groupParams = spaceParams.extend({ groupId: z.uuid() })

// No SVG: it can carry a script.
const BANNER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const BANNER_LIMIT = 5 * 1024 * 1024

class Refusal extends Error {
  readonly status: number

  constructor(status: number, error: string) {
    super(error)
    this.status = status
  }
}

function strongest(a: SpaceRole, b: SpaceRole): SpaceRole {
  const order = spaceRole.enumValues
  return order.indexOf(a) > order.indexOf(b) ? a : b
}

function callerOf(request: FastifyRequest) {
  if (!request.caller) throw new Error('authorize let a request through')
  return request.caller
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new Refusal(400, 'invalid_request')
  return result.data
}

// ldap-rest's refusals (last admin, unknown user, member with another role)
// reach the caller as they are. A 401 refuses this service's credentials, not
// the caller; Fastify would answer any other error with its statusCode, so it
// is wrapped to answer 500.
async function ldapRest<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof LdapRestError)) throw error
    const status = error.statusCode
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 401
    ) {
      throw new Refusal(status, error.code ?? 'ldap_rest_refused')
    }
    throw new Error('ldap-rest failed the write', { cause: error })
  }
}

type Route = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

function refusing(route: Route): Route {
  return async (request, reply) => {
    try {
      return await route(request, reply)
    } catch (error) {
      if (error instanceof Refusal) {
        return reply.code(error.status).send({ error: error.message })
      }
      throw error
    }
  }
}

// The organization's owners and admins manage the space without being in it.
async function tellMembersAndManagers(tx: Tx, orgId: string, spaceId: string) {
  const people = await tx
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .union(
      tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            inArray(organizationMembers.role, ['owner', 'admin'])
          )
        )
    )
  tell(
    tx,
    'spaces',
    people.map(p => p.userId),
    { spaceId }
  )
}

export function registerSpaceWriteRoutes(
  app: HttpServer,
  deps: { db: Db; authorize: Authorize; directory: SpaceDirectory }
) {
  const { db, authorize, directory } = deps

  async function actorOf(caller: Caller) {
    if (caller.userId === null) return undefined
    return directory.person(caller.organizationId, 'id', caller.userId)
  }

  async function administered(request: FastifyRequest, spaceId: string) {
    const caller = callerOf(request)
    const [space] = await reachableSpaces(db, caller, spaceId)
    if (!space) throw new Refusal(404, 'not_found')
    if (space.role !== 'admin') throw new Refusal(403, 'not_space_admin')
    const actor = await actorOf(caller)
    return { orgId: caller.organizationId, actor: actor?.email ?? null }
  }

  // A member who does not manage the space is told so; anyone else learns
  // nothing of it.
  async function managed(request: FastifyRequest, spaceId: string) {
    const caller = callerOf(request)
    const [space] = await managedSpaces(db, caller, eq(spaces.spaceId, spaceId))
    if (space) return { orgId: caller.organizationId, state: space.state }
    const [reached] = await reachableSpaces(db, caller, spaceId)
    throw reached
      ? new Refusal(403, 'not_space_manager')
      : new Refusal(404, 'not_found')
  }

  // Deletes the space through ldap-rest, then its copy. One ldap-rest no
  // longer knows is deleted all the same, or it would stay in the Bin for
  // good should its deletion event be lost.
  async function deleteForGood(
    request: FastifyRequest,
    orgId: string,
    id: string,
    actor: string | null
  ) {
    try {
      await ldapRest(() => directory.delete(orgId, id, actor))
    } catch (error) {
      if (!(error instanceof Refusal && error.status === 404)) throw error
    }
    const at = new Date()
    // The deletion tells the members; the organization's managers have the
    // Bin open too.
    await copy(request, () =>
      db.transaction(async tx => {
        await deleteSpace(tx, id, at, actor ?? `token:${orgId}`)
        await tellMembersAndManagers(tx, orgId, id)
      })
    )
  }

  async function memberOf(spaceId: string, userId: string) {
    const [member] = await db
      .select({
        uuid: spaceMembers.userId,
        username: spaceMembers.username,
        email: spaceMembers.email,
        displayName: spaceMembers.displayName,
        role: spaceMembers.role
      })
      .from(spaceMembers)
      .where(
        and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))
      )
    if (!member) throw new Refusal(404, 'not_found')
    return member
  }

  // Linked groups come back from ldap-rest with their names.
  async function copyGroups(
    orgId: string,
    spaceId: string,
    groupIds: string[],
    at: Date
  ) {
    const wanted = new Set(groupIds)
    const groups = (await directory.groups(orgId, spaceId)).filter(g =>
      wanted.has(g.id)
    )
    await db.transaction(tx => upsertGroups(tx, spaceId, at, groups))
  }

  // ldap-rest already took the write and its event brings the copy, so a
  // failure here must not answer 500 and invite a retry of the write.
  async function copy(request: FastifyRequest, write: () => Promise<unknown>) {
    try {
      await write()
    } catch (error) {
      request.log.error({ err: error }, 'copying a write ldap-rest took')
    }
  }

  const writeSpace = { preHandler: authorize('space:write') }
  const writeMembers = { preHandler: authorize('members:write') }

  // Each route stamps the copy after ldap-rest answered, so the event ldap-rest
  // sent for the same write is older and changes nothing.

  app.post(
    '/spaces',
    writeSpace,
    refusing(async (request, reply) => {
      const body = parse(
        z.object({
          name,
          description: z.string().trim().max(1000).default(''),
          color: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .nullable()
            .default(null),
          // Frontends up to 0.1.12 still send feed.
          apps: z
            .array(z.enum([...spaceTab.enumValues, 'feed']))
            .default(spaceTab.enumValues)
            .transform(apps => apps.filter(app => app !== 'feed'))
        }),
        request.body
      )
      const caller = callerOf(request)
      const creator = await actorOf(caller)
      if (!creator) throw new Refusal(403, 'needs_an_account')
      const orgId = caller.organizationId
      const { id } = await ldapRest(() =>
        directory.create(
          orgId,
          {
            name: body.name,
            members: [{ username: creator.username, role: 'admin' }]
          },
          creator.email
        )
      )
      const at = new Date()
      await copy(request, () =>
        db.transaction(async tx => {
          await tx.insert(spaceSettings).values({
            spaceId: id,
            description: body.description,
            color: body.color,
            apps: body.apps
          })
          await createSpace(
            tx,
            request.log,
            {
              id,
              organizationId: orgId,
              name: body.name,
              createdBy: creator.email.toLowerCase(),
              members: [{ ...creator, role: 'admin' }],
              groups: []
            },
            at
          )
        })
      )
      return reply.code(201).send({ id, name: body.name, role: 'admin' })
    })
  )

  app.patch(
    '/spaces/:id',
    writeSpace,
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const body = parse(
        z
          .object({
            name: name.optional(),
            description: z.string().trim().max(1000).optional(),
            apps: z.array(z.enum(spaceTab.enumValues)).optional()
          })
          .refine(
            b =>
              b.name !== undefined ||
              b.description !== undefined ||
              b.apps !== undefined
          ),
        request.body
      )
      const { orgId, actor } = await administered(request, id)
      const newName = body.name
      if (newName !== undefined) {
        await ldapRest(() => directory.rename(orgId, id, newName, actor))
        const at = new Date()
        await copy(request, () =>
          db.transaction(tx => renameSpace(tx, id, newName, at))
        )
      }
      const settings = {
        ...(body.description !== undefined && {
          description: body.description
        }),
        ...(body.apps && { apps: [...new Set(body.apps)] })
      }
      if (Object.keys(settings).length > 0) {
        await db.transaction(async tx => {
          await tx
            .insert(spaceSettings)
            .values({ spaceId: id, apps: spaceTab.enumValues, ...settings })
            .onConflictDoUpdate({
              target: spaceSettings.spaceId,
              set: settings
            })
          await tellSpaceMembers(tx, id)
        })
      }
      return reply.code(204).send()
    })
  )

  app.addContentTypeParser(
    BANNER_TYPES,
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body)
    }
  )

  // Authorized on request, before the body is read, so an unknown caller cannot
  // make us read 5 MB.
  app.put(
    '/spaces/:id/banner',
    { onRequest: authorize('space:write'), bodyLimit: BANNER_LIMIT },
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const image = request.body
      const contentType = request.headers['content-type']
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase()
      if (
        !Buffer.isBuffer(image) ||
        image.length === 0 ||
        contentType === undefined ||
        !BANNER_TYPES.includes(contentType)
      ) {
        throw new Refusal(415, 'not_an_image')
      }
      await administered(request, id)
      await db.transaction(async tx => {
        const banner = { contentType, image, updatedAt: new Date() }
        await tx
          .insert(spaceBanners)
          .values({ spaceId: id, ...banner })
          .onConflictDoUpdate({ target: spaceBanners.spaceId, set: banner })
        await tellSpaceMembers(tx, id)
      })
      return reply.code(204).send()
    })
  )

  app.put(
    '/spaces/:id/state',
    writeSpace,
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const { state } = parse(
        z.object({ state: z.enum(spaceState.enumValues) }),
        request.body
      )
      const { orgId } = await managed(request, id)
      await db.transaction(async tx => {
        await tx.update(spaces).set({ state }).where(eq(spaces.spaceId, id))
        await tellMembersAndManagers(tx, orgId, id)
      })
      return reply.code(204).send()
    })
  )

  // Only from the Bin, so that no space is lost in one step.
  app.delete(
    '/spaces/bin',
    writeSpace,
    refusing(async (request, reply) => {
      const caller = callerOf(request)
      const binned = await managedSpaces(
        db,
        caller,
        eq(spaces.state, 'trashed')
      )
      const actor = (await actorOf(caller))?.email ?? null
      // One by one: a failure leaves the rest in the Bin for the next try.
      for (const { id } of binned) {
        await deleteForGood(request, caller.organizationId, id, actor)
      }
      return reply.code(204).send()
    })
  )

  app.delete(
    '/spaces/:id',
    writeSpace,
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const { orgId, state } = await managed(request, id)
      if (state !== 'trashed') throw new Refusal(409, 'not_in_bin')
      const actor = (await actorOf(callerOf(request)))?.email ?? null
      await deleteForGood(request, orgId, id, actor)
      return reply.code(204).send()
    })
  )

  app.post(
    '/spaces/:id/members',
    writeMembers,
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const body = parse(
        z.object({
          usernames: z.array(z.string().min(1)).min(1).max(100),
          role
        }),
        request.body
      )
      const { orgId, actor } = await administered(request, id)
      await ldapRest(() =>
        directory.addMembers(orgId, id, body.usernames, body.role, actor)
      )
      const at = new Date()
      await copy(request, async () => {
        const people = await Promise.all(
          body.usernames.map(u => directory.person(orgId, 'username', u))
        )
        await db.transaction(tx =>
          upsertMembers(
            tx,
            request.log,
            id,
            at,
            people.flatMap(p => (p ? [{ ...p, role: body.role }] : []))
          )
        )
      })
      return reply.code(204).send()
    })
  )

  app.patch(
    '/spaces/:id/members/:userId',
    writeMembers,
    refusing(async (request, reply) => {
      const { id, userId } = parse(memberParams, request.params)
      const body = parse(z.object({ role }), request.body)
      const { orgId, actor } = await administered(request, id)
      const member = await memberOf(id, userId)
      // ldap-rest knows only the members a space holds directly; one in
      // through a linked group gets a role of their own, and keeps the
      // strongest of it and their groups' roles.
      const held = await ldapRest(() =>
        directory.setMemberRole(orgId, id, member.username, body.role, actor)
      ).then(
        () => body.role,
        async (error: unknown) => {
          if (!(
            error instanceof Refusal && error.message === 'MEMBER_NOT_FOUND'
          ))
            throw error
          await ldapRest(() =>
            directory.addMembers(orgId, id, [member.username], body.role, actor)
          )
          return strongest(body.role, member.role)
        }
      )
      const at = new Date()
      await copy(request, () =>
        db.transaction(tx =>
          upsertMembers(tx, request.log, id, at, [{ ...member, role: held }])
        )
      )
      return reply.code(204).send()
    })
  )

  app.delete(
    '/spaces/:id/members/:userId',
    writeMembers,
    refusing(async (request, reply) => {
      const { id, userId } = parse(memberParams, request.params)
      const { orgId, actor } = await administered(request, id)
      const member = await memberOf(id, userId)
      // Another admin removed them first; the copy just has not heard yet.
      await ldapRest(() =>
        directory.removeMember(orgId, id, member.username, actor)
      ).catch((error: unknown) => {
        if (!(
          error instanceof Refusal && error.message === 'MEMBER_NOT_FOUND'
        )) {
          throw error
        }
      })
      const at = new Date()
      await copy(request, () =>
        db.transaction(tx =>
          removeSpaceMembers(tx, request.log, id, at, [{ uuid: userId }])
        )
      )
      return reply.code(204).send()
    })
  )

  app.post(
    '/spaces/:id/groups',
    writeMembers,
    refusing(async (request, reply) => {
      const { id } = parse(spaceParams, request.params)
      const body = parse(
        z.object({ groupIds: z.array(z.uuid()).min(1).max(100), role }),
        request.body
      )
      const { orgId, actor } = await administered(request, id)
      await ldapRest(() =>
        directory.linkGroups(orgId, id, body.groupIds, body.role, actor)
      )
      const at = new Date()
      await copy(request, () => copyGroups(orgId, id, body.groupIds, at))
      return reply.code(204).send()
    })
  )

  app.patch(
    '/spaces/:id/groups/:groupId',
    writeMembers,
    refusing(async (request, reply) => {
      const { id, groupId } = parse(groupParams, request.params)
      const body = parse(z.object({ role }), request.body)
      const { orgId, actor } = await administered(request, id)
      await ldapRest(() =>
        directory.setGroupRole(orgId, id, groupId, body.role, actor)
      )
      const at = new Date()
      await copy(request, () => copyGroups(orgId, id, [groupId], at))
      return reply.code(204).send()
    })
  )

  app.delete(
    '/spaces/:id/groups/:groupId',
    writeMembers,
    refusing(async (request, reply) => {
      const { id, groupId } = parse(groupParams, request.params)
      const { orgId, actor } = await administered(request, id)
      await ldapRest(() => directory.unlinkGroup(orgId, id, groupId, actor))
      const at = new Date()
      await copy(request, () =>
        db.transaction(tx => unlinkGroups(tx, id, at, [groupId]))
      )
      return reply.code(204).send()
    })
  )
}
