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
  const known = data.pages.some(page => page.items.some(i => i.id === item.id))
  if (known) {
    return {
      ...data,
      pages: data.pages.map(page => ({
        ...page,
        items: page.items.map(i => (i.id === item.id ? item : i))
      }))
    }
  }
  // A changed item that is not loaded belongs to an older page.
  if (!isNew || !shows(item, filter)) return data
  const [first, ...rest] = data.pages
  if (!first) return data
  return {
    ...data,
    pages: [{ ...first, items: [item, ...first.items] }, ...rest]
  }
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
 * replaced in place, a new one goes on top of the filters that show it.
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
