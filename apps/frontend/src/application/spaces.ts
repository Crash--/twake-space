export const SPACE_ROLES = ['viewer', 'editor', 'admin'] as const

export type SpaceRole = (typeof SPACE_ROLES)[number]

/** A member as the space list shows it: enough for an avatar. */
export interface MemberSummary {
  id: string
  username: string
  displayName: string | null
  /** The address of the person's Twake Workplace instance, null while it has none. */
  workplaceFqdn: string | null
}

export interface SpaceSummary {
  id: string
  name: string
  role: SpaceRole
  /** The avatar color picked at creation. */
  color: string | null
  description: string
  members: MemberSummary[]
  /** When the person pinned the space, or null. */
  pinnedAt: string | null
  /** When the person last opened the space, or null. */
  openedAt: string | null
  /**
   * Whether the person may archive it, move it to the Bin, restore it and
   * delete it for good: its admins, the organization's owners and admins,
   * and the person who created it.
   */
  manages: boolean
}

export type ShelfState = 'archived' | 'trashed'

/** An archived space, or one in the Bin: the person may not be in it. */
export interface ShelvedSpace extends Omit<SpaceSummary, 'role'> {
  role: SpaceRole | null
}

const RECENT = 5

/**
 * The sidebar's sections: the pinned spaces, in the list's order, and the
 * five last opened that are not pinned, newest first.
 */
export function pinnedAndRecent(spaces: SpaceSummary[]): {
  pinned: SpaceSummary[]
  recent: SpaceSummary[]
} {
  return {
    pinned: spaces.filter(space => space.pinnedAt !== null),
    recent: spaces
      .filter(space => space.pinnedAt === null && space.openedAt !== null)
      .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''))
      .slice(0, RECENT)
  }
}

export type SpaceApp = 'chat' | 'tasks' | 'drive' | 'mail' | 'calendar'

export interface NewSpace {
  name: string
  description: string
  color: string | null
  apps: SpaceApp[]
}

export type SpaceChange = Partial<
  Pick<NewSpace, 'name' | 'description' | 'apps'>
>

export const RESOURCE_KINDS = [
  'matrix_space',
  'project',
  'drive',
  'mailbox',
  'calendar'
] as const

export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/** A person given a role on the space directly. */
export interface Member {
  id: string
  username: string
  email: string
  displayName: string | null
  workplaceFqdn: string | null
  role: SpaceRole
}

/** An organization group whose members all get its role on the space. */
export interface LinkedGroup {
  id: string
  name: string
  role: SpaceRole
}

export interface Space extends SpaceSummary {
  createdAt: string
  description: string
  /** The apps that have a tab when this deployment provides them. */
  apps: SpaceApp[]
  chat: boolean
  mail: boolean
  /** The organization's Matrix homeserver, once known. */
  homeserverUrl: string | null
  /** The organization's own Chat; null falls back to the deployment's. */
  chatUrl: string | null
  /** The version of the banner an admin uploaded; null for the default art. */
  banner: string | null
  members: Member[]
  groups: LinkedGroup[]
  /**
   * One entry per app this deployment provides. An id of null: the app is
   * still preparing the resource.
   */
  resources: { kind: ResourceKind; id: string | null }[]
}

/**
 * What a write rejects with when the backend refuses it. `code` is the
 * reason, for example ldap-rest refusing to remove the last admin.
 */
export interface Refusal {
  status: number
  code: string | null
  /** The backend's explanation, in English, when it gives one. */
  reason?: string
}

export function isRefusal(error: unknown): error is Refusal {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  )
}

const folded = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Whether a name holds the query, whatever the case and the accents. */
export function nameMatches(name: string, query: string): boolean {
  return folded(name).includes(folded(query.trim()))
}

/**
 * SpotSpace's order: the spaces whose name holds the query, those with news
 * first, then the last opened, the never opened last in the list's order.
 */
export function rankSpaces(
  spaces: SpaceSummary[],
  totals: ReadonlyMap<string, number>,
  query: string
): SpaceSummary[] {
  const hasNews = (space: SpaceSummary) => (totals.get(space.id) ?? 0) > 0
  return spaces
    .filter(space => nameMatches(space.name, query))
    .sort(
      (a, b) =>
        Number(hasNews(b)) - Number(hasNews(a)) ||
        (b.openedAt ?? '').localeCompare(a.openedAt ?? '')
    )
}

/**
 * Every write but create, the person's own marks and the state needs the
 * caller to be an admin of the space. The state and deleting for good need a
 * manager.
 */
export interface SpacesService {
  list: () => Promise<SpaceSummary[]>
  get: (id: string) => Promise<Space>
  /** The apps the deployment and the organization provide to a new space. */
  apps: () => Promise<SpaceApp[]>
  create: (space: NewSpace) => Promise<SpaceSummary>
  edit: (id: string, change: SpaceChange) => Promise<void>
  banner: (id: string) => Promise<Blob>
  setBanner: (id: string, image: Blob) => Promise<void>
  /** Deletes a space in the Bin for good, in every app. */
  remove: (id: string) => Promise<void>
  /** The archived spaces, or those in the Bin, that the person manages. */
  shelved: (state: ShelfState) => Promise<ShelvedSpace[]>
  /** Archives a space, moves it to the Bin, or restores it. */
  setState: (id: string, state: ShelfState | 'active') => Promise<void>
  /** Deletes for good every space in the Bin the person manages. */
  emptyBin: () => Promise<void>
  setPinned: (id: string, pinned: boolean) => Promise<void>
  /** Records that the person opened the space now. */
  markOpened: (id: string) => Promise<void>
  addMembers: (
    id: string,
    usernames: string[],
    role: SpaceRole
  ) => Promise<void>
  setMemberRole: (id: string, userId: string, role: SpaceRole) => Promise<void>
  removeMember: (id: string, userId: string) => Promise<void>
  linkGroups: (id: string, groupIds: string[], role: SpaceRole) => Promise<void>
  setGroupRole: (id: string, groupId: string, role: SpaceRole) => Promise<void>
  unlinkGroup: (id: string, groupId: string) => Promise<void>
}
