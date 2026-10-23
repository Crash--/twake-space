import { HTTPError, type KyInstance } from 'ky'

import type {
  FeedItem,
  FeedPage,
  FeedService,
  LinkPreview,
  SpaceNews
} from '@/application/feed'

export function httpFeed(api: KyInstance): FeedService {
  const feed = (spaceId: string, ...rest: string[]) =>
    ['spaces', spaceId, 'feed', ...rest].map(encodeURIComponent).join('/')
  const send = async (request: Promise<unknown>) => {
    await request
  }

  return {
    list: (spaceId, { category, before, q, limit }) =>
      api
        .get(feed(spaceId), {
          searchParams: {
            ...(category && { category }),
            ...(before && { before }),
            ...(q && { q }),
            ...(limit && { limit })
          }
        })
        .json<FeedPage>(),
    item: (spaceId, itemId) =>
      api.get(feed(spaceId, 'items', itemId)).json<FeedItem>(),
    readAt: async spaceId =>
      (await api.get(feed(spaceId, 'read')).json<{ readAt: string | null }>())
        .readAt,
    markRead: (spaceId, readAt) =>
      send(api.put(feed(spaceId, 'read'), { json: { readAt } })),
    news: async () =>
      (await api.get('feed/unread').json<{ spaces: SpaceNews[] }>()).spaces,
    post: (spaceId, body) =>
      api.post(feed(spaceId, 'posts'), { json: { body } }).json<FeedItem>(),
    edit: (spaceId, postId, body) =>
      api
        .patch(feed(spaceId, 'posts', postId), { json: { body } })
        .json<FeedItem>(),
    remove: (spaceId, postId) =>
      send(api.delete(feed(spaceId, 'posts', postId))),
    react: (spaceId, itemId, key) =>
      send(api.put(feed(spaceId, 'items', itemId, 'reactions', key))),
    unreact: (spaceId, itemId, key) =>
      send(api.delete(feed(spaceId, 'items', itemId, 'reactions', key))),
    linkPreview: async url => {
      try {
        return await api
          .get('link-preview', { searchParams: { url } })
          .json<LinkPreview>()
      } catch (error) {
        if (error instanceof HTTPError && error.response.status === 404) {
          return null
        }
        throw error
      }
    }
  }
}
