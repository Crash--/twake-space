import type { FeedItem } from '@/application/feed'
import type { ResourceKind, Space } from '@/application/spaces'

export const TABS = [
  'home',
  'feed',
  'chat',
  'tasks',
  'drive',
  'mail',
  'calendar'
] as const

export type Tab = (typeof TABS)[number]

export type TabState = 'off' | 'preparing' | 'stalled' | 'ready'

/** How long an app may take to prepare a new space's resource. */
export const PREPARING_MS = 2 * 60_000

// The home and the feed are TwakeSpace's own, with no app resource.
type OwnTab = 'home' | 'feed'

function isOwn(tab: Tab): tab is OwnTab {
  return tab === 'home' || tab === 'feed'
}

const RESOURCE: Record<Exclude<Tab, OwnTab>, ResourceKind> = {
  chat: 'matrix_space',
  tasks: 'project',
  drive: 'drive',
  mail: 'mailbox',
  calendar: 'calendar'
}

function isOn(space: Space, tab: Tab): boolean {
  if (tab === 'chat') return space.chat
  if (tab === 'mail') return space.mail
  return true
}

export function spaceTabs(
  space: Space,
  now: number
): { tab: Tab; state: TabState }[] {
  const waiting =
    now < Date.parse(space.createdAt) + PREPARING_MS ? 'preparing' : 'stalled'
  return TABS.flatMap((tab): { tab: Tab; state: TabState }[] => {
    if (isOwn(tab)) return [{ tab, state: 'ready' }]
    const resource = space.resources.find(r => r.kind === RESOURCE[tab])
    if (!resource || !space.apps.includes(tab)) return []
    if (!isOn(space, tab)) return [{ tab, state: 'off' }]
    const ready =
      resource.id !== null &&
      (resource.kind !== 'matrix_space' || space.homeserverUrl !== null)
    return [{ tab, state: ready ? 'ready' : waiting }]
  })
}

// Whether a tab is ready does not depend on the time, only preparing and
// stalled do.
export function isTabReady(space: Space, tab: Tab): boolean {
  return spaceTabs(space, 0).some(
    item => item.tab === tab && item.state === 'ready'
  )
}

/** The tab a card about an object in this container opens, if the space shows it. */
export function containerTab(space: Space, kind: ResourceKind): Tab | null {
  const tab = TABS.find(t => !isOwn(t) && RESOURCE[t] === kind)
  // Preparing or stalled, the tab is shown all the same.
  const shown = spaceTabs(space, Date.now()).some(
    item => item.tab === tab && item.state !== 'off'
  )
  return tab && shown ? tab : null
}

/**
 * Where a feed item opens: a card in its container's tab, anything else in
 * the feed, at the item. An event opens in Calendar's preview of it, a message
 * in Mail at the email, a folder in Drive at the folder.
 */
export function itemPlace(
  space: Space,
  item: FeedItem
): { tab: Tab; path: string; feedItem: string | null } {
  const container = item.kind === 'card' ? item.object.container : null
  const tab = container && containerTab(space, container.kind)
  const base = `/spaces/${space.id}/${tab ?? 'feed'}`
  if (!tab) return { tab: 'feed', path: base, feedItem: item.id }
  const below = item.kind === 'card' ? belowTab(tab, item.object) : ''
  return { tab, path: base + below, feedItem: null }
}

// The path under the tab's embed route that shows the object itself, if the
// app can: Calendar knows its event by uid, Mail its email by JMAP id, Drive
// its folder by id. A Drive file opens at the tab, as no card names its folder.
function belowTab(tab: Tab, object: { type: string; id: string }): string {
  const id = encodeURIComponent(object.id)
  if (tab === 'calendar') return `/events/${id}`
  if (tab === 'mail' && object.type === 'message') return `/email/${id}`
  if (tab === 'drive' && object.type === 'folder') return `/${id}`
  return ''
}
