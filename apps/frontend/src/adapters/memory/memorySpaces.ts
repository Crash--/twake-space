import type { MemoryOrganization } from '@/adapters/memory/memoryDirectory'
import type {
  Refusal,
  ShelfState,
  Space,
  SpaceSummary,
  SpacesService
} from '@/application/spaces'

const summary = ({
  id,
  name,
  role,
  color,
  description,
  pinnedAt,
  openedAt,
  manages,
  members
}: Space): SpaceSummary => ({
  id,
  name,
  role,
  color,
  description,
  pinnedAt,
  openedAt,
  manages,
  members: members.map(({ id, username, displayName, workplaceFqdn }) => ({
    id,
    username,
    displayName,
    workplaceFqdn
  }))
})

const refuse = (status: number, code: string) =>
  Promise.reject(
    Object.assign(new Error(code), { status, code } satisfies Refusal)
  )

export function memorySpaces(
  seed: Space[],
  organization: MemoryOrganization,
  shelves: Record<string, ShelfState> = {}
): SpacesService {
  let spaces = seed.map(space => ({ ...space }))
  const states = new Map(Object.entries(shelves))
  const active = () => spaces.filter(space => !states.has(space.id))
  const find = (id: string) => active().find(space => space.id === id)
  // Like the backend: whatever the state, for its managers only.
  const managed = (id: string) => {
    const space = spaces.find(s => s.id === id)
    if (!space) return refuse(404, 'not_found')
    if (!space.manages) return refuse(403, 'not_space_manager')
    return Promise.resolve(space)
  }
  const banners = new Map<string, Blob>()

  // Runs a change on a space the caller administers, like the backend.
  const write = (id: string, change: (space: Space) => void) => {
    const space = find(id)
    if (!space) return refuse(404, 'not_found')
    if (space.role !== 'admin') return refuse(403, 'not_space_admin')
    change(space)
    return Promise.resolve()
  }

  return {
    list: () => Promise.resolve(active().map(summary)),
    get: id => {
      const space = find(id)
      return space
        ? Promise.resolve(structuredClone(space))
        : refuse(404, 'not_found')
    },
    // The organization's mail is off, as on a new space below.
    apps: () => Promise.resolve(['chat', 'tasks', 'drive', 'calendar']),
    create: created => {
      const space: Space = {
        ...created,
        id: crypto.randomUUID(),
        role: 'admin',
        manages: true,
        createdAt: new Date().toISOString(),
        pinnedAt: null,
        openedAt: null,
        chat: true,
        mail: false,
        homeserverUrl: spaces[0]?.homeserverUrl ?? null,
        chatUrl: spaces[0]?.chatUrl ?? null,
        banner: null,
        members: [],
        groups: [],
        // A new space's apps are still preparing its resources.
        resources: [
          { kind: 'matrix_space', id: null },
          { kind: 'project', id: null },
          { kind: 'drive', id: null },
          { kind: 'mailbox', id: null },
          { kind: 'calendar', id: null }
        ]
      }
      spaces.push(space)
      return Promise.resolve(summary(space))
    },
    edit: (id, change) =>
      write(id, space => {
        Object.assign(space, change)
      }),
    banner: id => {
      const banner = banners.get(id)
      return banner ? Promise.resolve(banner) : refuse(404, 'not_found')
    },
    setBanner: (id, image) =>
      write(id, space => {
        banners.set(id, image)
        space.banner = new Date().toISOString()
      }),
    remove: async id => {
      await managed(id)
      if (states.get(id) !== 'trashed') return refuse(409, 'not_in_bin')
      spaces = spaces.filter(space => space.id !== id)
      states.delete(id)
    },
    shelved: state =>
      Promise.resolve(
        spaces
          .filter(space => space.manages && states.get(space.id) === state)
          .map(summary)
      ),
    setState: async (id, state) => {
      await managed(id)
      if (state === 'active') states.delete(id)
      else states.set(id, state)
    },
    emptyBin: () => {
      spaces = spaces.filter(
        space => !(space.manages && states.get(space.id) === 'trashed')
      )
      return Promise.resolve()
    },
    setPinned: (id, pinned) => {
      const space = find(id)
      if (!space) return refuse(404, 'not_found')
      space.pinnedAt = pinned ? new Date().toISOString() : null
      return Promise.resolve()
    },
    markOpened: id => {
      const space = find(id)
      if (!space) return refuse(404, 'not_found')
      space.openedAt = new Date().toISOString()
      return Promise.resolve()
    },
    addMembers: (id, usernames, role) =>
      write(id, space => {
        const added = organization.people
          .filter(person => usernames.includes(person.username))
          .map(({ id: userId, username, email, displayName }) => ({
            id: userId,
            username,
            email,
            displayName,
            workplaceFqdn: null,
            role
          }))
        space.members = [
          ...space.members.filter(m => !added.some(a => a.id === m.id)),
          ...added
        ]
      }),
    setMemberRole: (id, userId, role) =>
      write(id, space => {
        space.members = space.members.map(m =>
          m.id === userId ? { ...m, role } : m
        )
      }),
    removeMember: (id, userId) =>
      write(id, space => {
        space.members = space.members.filter(m => m.id !== userId)
      }),
    linkGroups: (id, groupIds, role) =>
      write(id, space => {
        const linked = organization.groups
          .filter(group => groupIds.includes(group.id))
          .map(group => ({ ...group, role }))
        space.groups = [
          ...space.groups.filter(g => !groupIds.includes(g.id)),
          ...linked
        ]
      }),
    setGroupRole: (id, groupId, role) =>
      write(id, space => {
        space.groups = space.groups.map(g =>
          g.id === groupId ? { ...g, role } : g
        )
      }),
    unlinkGroup: (id, groupId) =>
      write(id, space => {
        space.groups = space.groups.filter(g => g.id !== groupId)
      })
  }
}
