import { vi } from 'vitest'

import { memoryFeed } from '@/adapters/memory/memoryFeed'
import type { FeedItem, FeedService } from '@/application/feed'
import type { SpaceRole } from '@/application/spaces'

/** The feeds are keyed by space id; the caller is `u-me`, an admin unless said. */
export function fakeFeed(
  feeds: Record<string, FeedItem[]> = {},
  {
    roles = {},
    readAt,
    mentions,
    pageSize
  }: {
    roles?: Record<string, SpaceRole>
    readAt?: Record<string, string>
    mentions?: Record<string, number>
    pageSize?: number
  } = {}
): FeedService {
  const feed = memoryFeed(feeds, {
    me: { id: 'u-me', name: 'Me' },
    roles,
    ...(readAt && { readAt }),
    ...(mentions && { mentions }),
    ...(pageSize && { pageSize })
  })
  return {
    list: vi.fn(feed.list),
    item: vi.fn(feed.item),
    readAt: vi.fn(feed.readAt),
    markRead: vi.fn(feed.markRead),
    news: vi.fn(feed.news),
    post: vi.fn(feed.post),
    edit: vi.fn(feed.edit),
    remove: vi.fn(feed.remove),
    vote: vi.fn(feed.vote),
    unvote: vi.fn(feed.unvote),
    closePoll: vi.fn(feed.closePoll),
    react: vi.fn(feed.react),
    unreact: vi.fn(feed.unreact),
    linkPreview: vi.fn(feed.linkPreview)
  }
}
