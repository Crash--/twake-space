import {
  LdapRestClient,
  NotFoundError,
  type User
} from '@linagora/ldap-rest-client'
import type { Config } from '../config.ts'

export interface Member {
  username: string
  email: string
  displayName: string
  firstName: string
  lastName: string
}

export interface MemberPage {
  members: Member[]
  total: number
  hasNextPage: boolean
}

export interface Directory {
  listMembers(
    orgId: string,
    query: { page: number; limit: number; search?: string }
  ): Promise<MemberPage>
  listGroups(
    orgId: string,
    query: { page: number; limit: number; search?: string }
  ): Promise<{ groups: { id: string; name: string }[]; hasNextPage: boolean }>
  findMember(
    orgId: string,
    by: 'username' | 'email' | 'id',
    value: string
  ): Promise<Member | undefined>
  organizationOf(email: string): Promise<string | undefined>
  organization(orgId: string): Promise<Organization | undefined>
  isTechnicalAccount(orgId: string, accountId: string): Promise<boolean>
  isMember(orgId: string, accountId: string): Promise<boolean>
  organizationRole(
    orgId: string,
    accountId: string
  ): Promise<{ email: string; role: OrganizationRole } | undefined>
  workplaceFqdn(orgId: string, accountId: string): Promise<string | null>
}

const organizationRoles = ['owner', 'admin', 'moderator', 'member'] as const

export type OrganizationRole = (typeof organizationRoles)[number]

export interface Organization {
  domain: string
  chat: boolean
  mail: boolean
}

export type SpaceRole = 'viewer' | 'editor' | 'admin'

export interface Person {
  uuid: string
  username: string
  email: string
  displayName: string | null
}

// A member ldap-rest cannot read comes with its username and role only.
export type ListedMember = {
  username: string
  role: SpaceRole
  displayName: string | null
  uuid?: string | undefined
  email?: string | undefined
}

// ldap-rest gives a member's first and last name, not the display name.
export const fullName = (firstName?: unknown, lastName?: unknown) =>
  [firstName, lastName]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ') || null

// `actor` is the acting user's email, so ldap-rest's events name them; null
// when an organization token acts.
export interface SpaceDirectory {
  // Undefined for an organization ldap-rest does not know.
  list(orgId: string): Promise<{ id: string; name: string }[] | undefined>
  members(orgId: string, spaceId: string): Promise<ListedMember[]>
  exists(orgId: string, spaceId: string): Promise<boolean>
  person(
    orgId: string,
    by: 'username' | 'id',
    value: string
  ): Promise<Person | undefined>
  create(
    orgId: string,
    space: { name: string; members: { username: string; role: SpaceRole }[] },
    actor: string | null
  ): Promise<{ id: string }>
  rename(
    orgId: string,
    spaceId: string,
    name: string,
    actor: string | null
  ): Promise<void>
  delete(orgId: string, spaceId: string, actor: string | null): Promise<void>
  addMembers(
    orgId: string,
    spaceId: string,
    usernames: string[],
    role: SpaceRole,
    actor: string | null
  ): Promise<void>
  setMemberRole(
    orgId: string,
    spaceId: string,
    username: string,
    role: SpaceRole,
    actor: string | null
  ): Promise<void>
  removeMember(
    orgId: string,
    spaceId: string,
    username: string,
    actor: string | null
  ): Promise<void>
  linkGroups(
    orgId: string,
    spaceId: string,
    groupIds: string[],
    role: SpaceRole,
    actor: string | null
  ): Promise<void>
  setGroupRole(
    orgId: string,
    spaceId: string,
    groupId: string,
    role: SpaceRole,
    actor: string | null
  ): Promise<void>
  unlinkGroup(
    orgId: string,
    spaceId: string,
    groupId: string,
    actor: string | null
  ): Promise<void>
  groups(
    orgId: string,
    spaceId: string
  ): Promise<{ id: string; name: string; role: SpaceRole }[]>
}

export function ldapRestSpaces(
  client: Pick<LdapRestClient, 'organizations' | 'spaces'>
): SpaceDirectory {
  const { spaces } = client
  const as = (actor: string | null) => actor ?? undefined
  return {
    list(orgId) {
      return notFoundAsUndefined(
        pages(async page => {
          const { spaces: listed, pagination } = await spaces.list(orgId, {
            page,
            limit: PAGE
          })
          return {
            items: listed.map(({ id, name }) => ({ id, name })),
            last: page >= pagination.totalPages
          }
        })
      )
    },
    members(orgId, spaceId) {
      return pages(async page => {
        const { members, pagination } = await spaces.listMembers(
          orgId,
          spaceId,
          { page, limit: PAGE }
        )
        return {
          items: members.map(m => ({
            username: m.uid,
            role: m.role,
            displayName: fullName(m['givenName'], m['sn']),
            uuid: typeof m['_id'] === 'string' ? m['_id'] : undefined,
            email: typeof m['mail'] === 'string' ? m['mail'] : undefined
          })),
          last: !pagination.hasNextPage
        }
      })
    },
    async exists(orgId, spaceId) {
      return (
        (await notFoundAsUndefined(spaces.get(orgId, spaceId))) !== undefined
      )
    },
    async person(orgId, by, value) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by, value })
      )
      if (!user?._id) return undefined
      return {
        uuid: user._id,
        username: user.uid,
        email: user.mail,
        displayName: user.displayName || null
      }
    },
    async create(orgId, space, actor) {
      const { id } = await spaces.create(orgId, space, as(actor))
      return { id }
    },
    async rename(orgId, spaceId, name, actor) {
      await spaces.rename(orgId, spaceId, name, as(actor))
    },
    async delete(orgId, spaceId, actor) {
      await spaces.delete(orgId, spaceId, as(actor))
    },
    async addMembers(orgId, spaceId, usernames, role, actor) {
      await spaces.addMembers(orgId, spaceId, { usernames, role }, as(actor))
    },
    async setMemberRole(orgId, spaceId, username, role, actor) {
      await spaces.setMemberRole(orgId, spaceId, username, role, as(actor))
    },
    async removeMember(orgId, spaceId, username, actor) {
      await spaces.removeMember(orgId, spaceId, username, as(actor))
    },
    async linkGroups(orgId, spaceId, groupIds, role, actor) {
      await spaces.linkGroups(orgId, spaceId, { groupIds, role }, as(actor))
    },
    async setGroupRole(orgId, spaceId, groupId, role, actor) {
      await spaces.setGroupRole(orgId, spaceId, groupId, role, as(actor))
    },
    async unlinkGroup(orgId, spaceId, groupId, actor) {
      await spaces.unlinkGroup(orgId, spaceId, groupId, as(actor))
    },
    async groups(orgId, spaceId) {
      return (await spaces.listGroups(orgId, spaceId)).groups
    }
  }
}

export function createLdapRestClient(config: Config): LdapRestClient {
  return new LdapRestClient({
    baseUrl: config.LDAP_REST_URL,
    auth: {
      type: 'hmac',
      serviceId: config.LDAP_REST_SERVICE_ID,
      secret: config.LDAP_REST_SECRET
    },
    // Calls run inside event transactions: a slow directory must not hold them.
    timeout: 5000,
    logger: { type: 'hidden' }
  })
}

export function ldapRestDirectory(
  client: Pick<LdapRestClient, 'organizations' | 'users' | 'groups'>
): Directory {
  return {
    async organizationOf(email) {
      const user = await notFoundAsUndefined(
        client.users.fetch({ by: 'email', value: email })
      )
      return user?.organizationId
    },
    async isTechnicalAccount(orgId, accountId) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by: 'id', value: accountId })
      )
      return user?.isTechnical === true && user.isDeleted !== true
    },
    async isMember(orgId, accountId) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by: 'id', value: accountId })
      )
      return user !== undefined && user.isDeleted !== true
    },
    async organizationRole(orgId, accountId) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by: 'id', value: accountId })
      )
      const role = user?.organizationRole
      if (!user || user.isDeleted === true || !isOrganizationRole(role)) {
        return undefined
      }
      return { email: user.mail, role }
    },
    async workplaceFqdn(orgId, accountId) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by: 'id', value: accountId })
      )
      if (!user || user.isDeleted === true) return null
      // Despite its name, ldap-rest writes the bare address, like `alice.twake.app`.
      return user.workspaceUrl || null
    },
    async organization(orgId) {
      const organization = await notFoundAsUndefined(
        client.organizations.get(orgId)
      )
      if (!organization || organization.status === 'deleted') return undefined
      return {
        domain: organization.domain,
        chat: organization.metadata?.['isChatServerDeployed'] === true,
        mail: organization.metadata?.['isMailDomainValid'] === true
      }
    },
    async listMembers(orgId, query) {
      const { users, pagination } = await client.organizations.listUsers(
        orgId,
        { ...query, status: 'active' }
      )
      return {
        members: users.map(toMember),
        total: pagination.total,
        hasNextPage: pagination.hasNextPage
      }
    },
    async listGroups(orgId, query) {
      const { groups, pagination } = await client.groups.list(orgId, query)
      return {
        // The cn is the group's id; its name is in displayName, which the
        // client does not type yet.
        groups: groups.map(group => {
          const { displayName } = group as { displayName?: unknown }
          return {
            id: group.id,
            name: typeof displayName === 'string' ? displayName : group.cn
          }
        }),
        hasNextPage: pagination.page < pagination.totalPages
      }
    },
    async findMember(orgId, by, value) {
      const user = await notFoundAsUndefined(
        client.organizations.getUser(orgId, { by, value })
      )
      return user && toMember(user)
    }
  }
}

const PAGE = 100

async function pages<T>(
  read: (page: number) => Promise<{ items: T[]; last: boolean }>
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const { items, last } = await read(page)
    all.push(...items)
    if (last || items.length === 0) return all
  }
}

async function notFoundAsUndefined<T>(
  request: Promise<T>
): Promise<T | undefined> {
  try {
    return await request
  } catch (error) {
    if (error instanceof NotFoundError) return undefined
    throw error
  }
}

function isOrganizationRole(role: unknown): role is OrganizationRole {
  return organizationRoles.some(r => r === role)
}

function toMember(user: User): Member {
  return {
    username: user.uid,
    email: user.mail,
    displayName: user.displayName,
    firstName: user.givenName,
    lastName: user.sn
  }
}
