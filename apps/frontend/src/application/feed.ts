import type { ResourceKind } from '@/application/spaces'

export const FEED_CATEGORIES = [
  'messages',
  'files',
  'activities',
  'events'
] as const

export type FeedCategory = (typeof FEED_CATEGORIES)[number]

export type FeedFilter = 'all' | FeedCategory

/** A user's name is null when they are not a member of the space. */
export type Actor =
  | { type: 'user'; id: string | null; name: string | null }
  | { type: 'token'; id: string; name: string }
  | { type: 'deleted_user' }

/** A card holds ids, never a link: the frontend opens the container's tab. */
export interface FeedObject {
  type: string
  id: string
  title: string
  container: { kind: ResourceKind; id: string } | null
}

export interface Reaction {
  key: string
  /** In the order they reacted. */
  userIds: string[]
}

interface ItemBase {
  id: string
  category: FeedCategory
  time: string
  updatedAt: string
  reactions: Reaction[]
}

/**
 * One card per object, and per member for a Drive folder digest. It keeps its
 * first time, a folder digest its latest window's, and shows the latest event.
 */
export interface FeedCard extends ItemBase {
  kind: 'card'
  /** The latest activity event type, like `com.twake.tasks.task.moved.v1`. */
  type: string
  actor: Actor | null
  object: FeedObject
  preview: string | null
  state: Record<string, unknown>
  /** A Drive folder digest: the files of one window, up to five names. */
  files: FileCounts | null
}

export interface FileCounts {
  created: number
  updated: number
  deleted: number
  samples: string[]
}

export interface FeedPost extends ItemBase {
  kind: 'post'
  author: Actor
  body: string
  editedAt: string | null
}

export type FeedItem = FeedCard | FeedPost

/** Newest first. `next` is the cursor of the older page, if any. */
export interface FeedPage {
  items: FeedItem[]
  next: string | null
}

/** A space's items newer than the user's read time, and unread mentions. */
export interface SpaceNews {
  spaceId: string
  items: number
  mentions: number
}

export interface FeedService {
  list: (
    spaceId: string,
    options: {
      category?: FeedCategory
      before?: string
      /** Matches card titles and previews, and post bodies. */
      q?: string
      limit?: number
    }
  ) => Promise<FeedPage>
  item: (spaceId: string, itemId: string) => Promise<FeedItem>
  /** The time of the newest item the user has seen, null before a first visit. */
  readAt: (spaceId: string) => Promise<string | null>
  /** Keeps the later of the stored time and this one. */
  markRead: (spaceId: string, readAt: string) => Promise<void>
  /** Only the spaces with something new; a feed never opened has no new items. */
  news: () => Promise<SpaceNews[]>
  /** Editors and admins only: a viewer is refused with `cannot_post`. */
  post: (spaceId: string, body: string) => Promise<FeedItem>
  edit: (spaceId: string, postId: string, body: string) => Promise<FeedItem>
  remove: (spaceId: string, postId: string) => Promise<void>
  react: (spaceId: string, itemId: string, key: string) => Promise<void>
  unreact: (spaceId: string, itemId: string, key: string) => Promise<void>
  /** Null when the page cannot be read or has no title. */
  linkPreview: (url: string) => Promise<LinkPreview | null>
}

/** Read by the backend: `image` is a `data:` URL. */
export interface LinkPreview {
  url: string
  title: string
  description: string | null
  image: string | null
  site: string
}

/** The first web link in a post's text, without the punctuation that ends a sentence. */
export function firstLink(text: string): string | null {
  let link = /\bhttps?:\/\/[^\s<>"]+/i.exec(text)?.[0]
  if (link === undefined) return null
  // A closing parenthesis the link opened is part of it, as in Wikipedia's.
  while (/[.,;:!?')\]]$/.test(link)) {
    if (link.endsWith(')') && link.split(')').length <= link.split('(').length)
      break
    link = link.slice(0, -1)
  }
  return link
}

/** The `feed` live event. */
export interface FeedChange {
  spaceId: string
  itemId: string
  change: 'added' | 'changed' | 'removed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function toFeedChange(data: unknown): FeedChange | null {
  if (
    !isRecord(data) ||
    typeof data.spaceId !== 'string' ||
    typeof data.itemId !== 'string'
  ) {
    return null
  }
  const { spaceId, itemId, change } = data
  return change === 'added' || change === 'changed' || change === 'removed'
    ? { spaceId, itemId, change }
    : null
}

export function shows(item: FeedItem, filter: FeedFilter): boolean {
  return filter === 'all' || item.category === filter
}

/** The oldest item newer than `readAt`, among items oldest first. */
export function firstUnread(
  items: FeedItem[],
  readAt: string | null
): FeedItem | null {
  if (readAt === null) return null
  const read = Date.parse(readAt)
  return items.find(item => Date.parse(item.time) > read) ?? null
}

/** What a search matches an item on, as the backend does. */
export function searchedText(item: FeedItem): string[] {
  if (item.kind === 'post') return [item.body]
  return [item.object.title, item.preview ?? '']
}

/** The item once a user has added (`on`) or taken back a reaction. */
export function withReaction<T extends FeedItem>(
  item: T,
  key: string,
  userId: string,
  on: boolean
): T {
  const others = (r: Reaction) => r.userIds.filter(id => id !== userId)
  const has = item.reactions.some(
    r => r.key === key && r.userIds.includes(userId)
  )
  if (has === on) return item
  const reactions = on
    ? item.reactions.some(r => r.key === key)
      ? item.reactions.map(r =>
          r.key === key ? { ...r, userIds: [...r.userIds, userId] } : r
        )
      : [...item.reactions, { key, userIds: [userId] }]
    : item.reactions
        .map(r => (r.key === key ? { ...r, userIds: others(r) } : r))
        .filter(r => r.userIds.length > 0)
  return { ...item, reactions }
}

/** The app that sent a card, as in `com.twake.<app>.*`. */
export function cardApp(card: FeedCard): string | null {
  return /^com\.twake\.([a-z]+)\./.exec(card.type)?.[1] ?? null
}

/** What happened last, as in `com.twake.<app>.<object>.<action>.v1`. */
export function cardAction(card: FeedCard): string | null {
  return /\.([a-z_]+)\.v\d+$/.exec(card.type)?.[1] ?? null
}

/** The upper-case extension of a file name, like `PPTX`, or null without one. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return /^[a-z0-9]{1,5}$/i.test(extension) ? extension.toUpperCase() : null
}

export interface TimeRange {
  start: string
  end: string
}

/** A calendar card's state; `allDay` times are dates, `YYYY-MM-DD`. */
export interface EventState extends TimeRange {
  allDay: boolean
  location: string | null
  previous: TimeRange | null
  proposed: (TimeRange & { by: string }) | null
  rsvp: Record<'accepted' | 'declined' | 'tentative' | 'pending', number> | null
  /** The Meet room's slug, not its URL. */
  room: string | null
}

function toRsvp(value: unknown): EventState['rsvp'] {
  if (!isRecord(value)) return null
  const count = (key: string) =>
    typeof value[key] === 'number' ? value[key] : 0
  return {
    accepted: count('accepted'),
    declined: count('declined'),
    tentative: count('tentative'),
    pending: count('pending')
  }
}

function toRange(value: unknown): TimeRange | null {
  return isRecord(value) &&
    typeof value.start === 'string' &&
    typeof value.end === 'string'
    ? { start: value.start, end: value.end }
    : null
}

export function toEventState(
  state: Record<string, unknown>
): EventState | null {
  const range = toRange(state)
  if (!range) return null
  const proposed = toRange(state.proposed)
  const by = isRecord(state.proposed) ? state.proposed.by : null
  return {
    ...range,
    allDay: state.allDay === true,
    location: typeof state.location === 'string' ? state.location : null,
    previous: toRange(state.previous),
    proposed: proposed && typeof by === 'string' ? { ...proposed, by } : null,
    rsvp: toRsvp(state.rsvp),
    room:
      isRecord(state.meeting) && typeof state.meeting.room === 'string'
        ? state.meeting.room
        : null
  }
}
