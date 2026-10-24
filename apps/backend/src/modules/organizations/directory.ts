import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { HttpServer } from '../../infra/http.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import type { Authorize } from '../auth/index.ts'

const PAGE_SIZE = 20

// ldap-rest needs two characters to search.
const query = z.object({
  search: z.string().trim().min(2).optional(),
  page: z.coerce.number().int().min(1).default(1)
})

function searchOf(request: FastifyRequest) {
  if (!request.caller) throw new Error('authorize let a request through')
  const result = query.safeParse(request.query)
  if (!result.success) return null
  const { search, page } = result.data
  return {
    orgId: request.caller.organizationId,
    query: { page, limit: PAGE_SIZE, ...(search && { search }) }
  }
}

// An organization token below admin adds no one to a space, so finds no one.
function addsNoOne(request: FastifyRequest) {
  const { caller } = request
  return (
    caller?.kind === 'token' &&
    caller.userId === null &&
    caller.role !== 'admin'
  )
}

// The people and groups a space admin picks from.
export function registerDirectoryRoutes(
  app: HttpServer,
  deps: {
    authorize: Authorize
    directory: Pick<Directory, 'listMembers' | 'listGroups'>
  }
) {
  const { directory } = deps
  // A token that adds people to spaces needs to find them.
  const preHandler = deps.authorize('members:write')

  app.get('/organization/members', { preHandler }, async (request, reply) => {
    if (addsNoOne(request)) return reply.code(403).send({ error: 'forbidden' })
    const search = searchOf(request)
    if (!search) return reply.code(400).send({ error: 'invalid_request' })
    const page = await directory.listMembers(search.orgId, search.query)
    return {
      members: page.members.map(({ username, email, displayName }) => ({
        username,
        email,
        displayName
      })),
      hasNextPage: page.hasNextPage
    }
  })

  app.get('/organization/groups', { preHandler }, async (request, reply) => {
    if (addsNoOne(request)) return reply.code(403).send({ error: 'forbidden' })
    const search = searchOf(request)
    if (!search) return reply.code(400).send({ error: 'invalid_request' })
    return directory.listGroups(search.orgId, search.query)
  })
}
