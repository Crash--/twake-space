import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey
} from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  shows,
  toFeedChange,
  type FeedFilter,
  type FeedItem,
  type FeedPage,
  type FeedService
} from '@/application/feed'
import { isRefusal } from '@/application/spaces'
import { useServices } from '@/ui/services/Services'

const feedKey = (spaceId: string, filter?: FeedFilter): QueryKey =>
  filter ? ['feed', spaceId, filter] : ['feed', spaceId]

export function useFeed(spaceId: string, filter: FeedFilter) {
  const { feed } = useServices()
  return useInfiniteQuery({
    queryKey: feedKey(spaceId, filter),
    queryFn: ({ pageParam }) =>
      feed.list(spaceId, {
        ...(filter !== 'all' && { category: filter }),
        ...(pageParam && { before: pageParam })
      }),
    initialPageParam: '',
    getNextPageParam: page => page.next
  })
}

// Read once per visit, so the new items' mark stays where the visit found it.
// The feed waits for it: a failure opens the feed with no mark at once.
export function useFeedReadAt(spaceId: string) {
  const { feed } = useServices()
  return useQuery({
    queryKey: ['feedRead', spaceId],
    queryFn: () => feed.readAt(spaceId),
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  })
}

export const FEED_NEWS: QueryKey = ['feedNews']

export function useFeedNews() {
  const { feed } = useServices()
  return useQuery({ queryKey: FEED_NEWS, queryFn: () => feed.news() })
}

// Kept apart from `feedKey`: live changes write into every query under it.
const searchQuery = (
  feed: FeedService,
  spaceId: string,
  q: string,
  limit: number
) => ({
  queryKey: ['feedSearch', spaceId, q, limit],
  queryFn: () => feed.list(spaceId, { q, limit }),
  enabled: q !== ''
})

export function useFeedSearch(spaceId: string, q: string, limit: number) {
  const { feed } = useServices()
  return useQuery(searchQuery(feed, spaceId, q, limit))
}

/** The matches of every space, newest first. A failed space is left out. */
export function useFeedSearchAll(
  spaceIds: string[],
  q: string,
  limit: number
): { items: { spaceId: string; item: FeedItem }[]; isFetching: boolean } {
  const { feed } = useServices()
  return useQueries({
    queries: spaceIds.map(id => searchQuery(feed, id, q, limit)),
    combine: results => ({
      items: results
        .flatMap((result, index) =>
          (result.data?.items ?? []).map(item => ({
            spaceId: spaceIds[index] ?? '',
            item
          }))
        )
        .sort((a, b) => b.item.time.localeCompare(a.item.time))
        .slice(0, limit),
      isFetching: results.some(result => result.isFetching)
    })
  })
}

type Pages = InfiniteData<FeedPage, string>

function withItem(
  data: Pages,
  item: FeedItem,
  filter: FeedFilter,
  isNew: boolean
): Pages {
  const old = data.pages.flatMap(page => page.items).find(i => i.id === item.id)
  if (old?.time === item.time) {
    return {
      ...data,
      pages: data.pages.map(page => ({
        ...page,
        items: page.items.map(i => (i.id === item.id ? item : i))
      }))
    }
  }
  if (!shows(item, filter)) return data
  const pages = withoutItem(data, item.id).pages
  if (isNew && !old) {
    const [first, ...rest] = pages
    if (!first) return data
    return {
      ...data,
      pages: [{ ...first, items: [item, ...first.items] }, ...rest]
    }
  }
  // A folder digest card takes the time of its latest window, so it moves to
  // its place in the server's order. A changed item older than every loaded
  // one belongs to an older page.
  const index = pages.findIndex(page => page.items.some(i => isBefore(item, i)))
  const last = pages.length - 1
  if (index === -1 && (!old || last < 0 || pages[last]?.next)) {
    return { ...data, pages }
  }
  const at = index === -1 ? last : index
  return {
    ...data,
    pages: pages.map((page, p) => {
      if (p !== at) return page
      const i = page.items.findIndex(other => isBefore(item, other))
      const items = [...page.items]
      items.splice(i === -1 ? items.length : i, 0, item)
      return { ...page, items }
    })
  }
}

// The server's order: newest first, then by id.
function isBefore(a: FeedItem, b: FeedItem): boolean {
  return a.time > b.time || (a.time === b.time && a.id > b.id)
}

function withoutItem(data: Pages, itemId: string): Pages {
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      items: page.items.filter(i => i.id !== itemId)
    }))
  }
}

/**
 * Writes an item into every loaded filter of the space's feed: a known one is
 * replaced in place unless its time changed, a new one goes on top of the
 * filters that show it.
 */
function putItem(
  queryClient: QueryClient,
  spaceId: string,
  item: FeedItem,
  isNew: boolean
): void {
  for (const [key, data] of queryClient.getQueriesData<Pages>({
    queryKey: feedKey(spaceId)
  })) {
    const filter = key[2] as FeedFilter
    if (data) {
      queryClient.setQueryData(key, withItem(data, item, filter, isNew))
    }
  }
}

function dropItem(
  queryClient: QueryClient,
  spaceId: string,
  itemId: string
): void {
  queryClient.setQueriesData<Pages>(
    { queryKey: feedKey(spaceId) },
    data => data && withoutItem(data, itemId)
  )
}

export function useFeedCache(spaceId: string) {
  const queryClient = useQueryClient()
  const add = useCallback(
    (item: FeedItem) => {
      putItem(queryClient, spaceId, item, true)
    },
    [queryClient, spaceId]
  )
  const replace = useCallback(
    (item: FeedItem) => {
      putItem(queryClient, spaceId, item, false)
    },
    [queryClient, spaceId]
  )
  const drop = useCallback(
    (itemId: string) => {
      dropItem(queryClient, spaceId, itemId)
    },
    [queryClient, spaceId]
  )
  return { add, replace, drop }
}

/** Applies a `feed` live event to the space's feed, if it is loaded. */
export function followFeedChange(
  queryClient: QueryClient,
  feed: FeedService,
  data: unknown
): void {
  const change = toFeedChange(data)
  if (!change) return
  const { spaceId, itemId } = change
  if (queryClient.getQueriesData({ queryKey: feedKey(spaceId) }).length === 0) {
    return
  }
  if (change.change === 'removed') {
    dropItem(queryClient, spaceId, itemId)
    return
  }
  feed.item(spaceId, itemId).then(
    item => {
      putItem(queryClient, spaceId, item, change.change === 'added')
    },
    (error: unknown) => {
      if (isRefusal(error) && error.status === 404) {
        dropItem(queryClient, spaceId, itemId)
      }
    }
  )
}
