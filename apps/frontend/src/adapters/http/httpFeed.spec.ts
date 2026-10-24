import { afterEach, describe, expect, it, vi } from 'vitest'

import { backend } from '@/adapters/http/backend'
import { httpFeed } from '@/adapters/http/httpFeed'
import type { FeedItem } from '@/application/feed'

vi.mock('@linagora/twake-oidc', () => ({
  addAuthorization: vi.fn(),
  redirectOnUnauthorized: vi.fn()
}))

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)

const feed = httpFeed(backend('https://api.test/'))

const post: FeedItem = {
  id: 'p1',
  kind: 'post',
  category: 'messages',
  time: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  reactions: [],
  author: { type: 'user', id: 'u1', name: 'Bob' },
  body: 'Hello',
  editedAt: null,
  poll: null
}

function requested(): Request {
  const [request] = fetchMock.mock.calls[0] ?? []
  if (!(request instanceof Request)) throw new Error('no request sent')
  return request
}

afterEach(() => {
  fetchMock.mockReset()
})

describe('httpFeed', () => {
  it("reads a page of the space's feed", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [post], next: 'c2' }))

    await expect(feed.list('a1', {})).resolves.toEqual({
      items: [post],
      next: 'c2'
    })
    expect(requested().url).toBe('https://api.test/spaces/a1/feed')
  })

  it('reads an older page of one category', async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [], next: null }))

    await feed.list('a1', { category: 'events', before: 'c2' })

    expect(requested().url).toBe(
      'https://api.test/spaces/a1/feed?category=events&before=c2'
    )
  })

  it('reads one item', async () => {
    fetchMock.mockResolvedValue(Response.json(post))

    await expect(feed.item('a1', 'p1')).resolves.toEqual(post)
    expect(requested().url).toBe('https://api.test/spaces/a1/feed/items/p1')
  })

  it('reads what is new in every space', async () => {
    const news = [{ spaceId: 'a1', items: 3, mentions: 1 }]
    fetchMock.mockResolvedValue(Response.json({ spaces: news }))

    await expect(feed.news()).resolves.toEqual(news)
    expect(requested().url).toBe('https://api.test/feed/unread')
  })

  it('answers a new post with the item', async () => {
    fetchMock.mockResolvedValue(Response.json(post, { status: 201 }))

    await expect(feed.post('a1', 'Hello', [])).resolves.toEqual(post)
  })

  it("reads a link's preview", async () => {
    const preview = {
      url: 'https://example.com/a',
      title: 'Example',
      description: null,
      image: null,
      site: 'example.com'
    }
    fetchMock.mockResolvedValue(Response.json(preview))

    await expect(feed.linkPreview('https://example.com/a')).resolves.toEqual(
      preview
    )
    expect(requested().url).toBe(
      'https://api.test/link-preview?url=https%3A%2F%2Fexample.com%2Fa'
    )
  })

  it('reads no preview for a link the backend cannot read', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'no_preview' }, { status: 404 })
    )

    await expect(feed.linkPreview('https://example.com/')).resolves.toBeNull()
  })

  const thumbsUp = '%F0%9F%91%8D'

  it.each([
    {
      write: () => feed.post('a1', 'Hello @Alice', ['u1']),
      method: 'POST',
      path: 'spaces/a1/feed/posts',
      body: { body: 'Hello @Alice', mentions: ['u1'] }
    },
    {
      write: () =>
        feed.post('a1', 'Lunch?', [], { options: ['Pizza', 'Sushi'] }),
      method: 'POST',
      path: 'spaces/a1/feed/posts',
      body: {
        body: 'Lunch?',
        mentions: [],
        poll: { options: ['Pizza', 'Sushi'] }
      }
    },
    {
      write: () => feed.vote('a1', 'p1', 1),
      method: 'PUT',
      path: 'spaces/a1/feed/posts/p1/vote',
      body: { option: 1 }
    },
    {
      write: () => feed.unvote('a1', 'p1'),
      method: 'DELETE',
      path: 'spaces/a1/feed/posts/p1/vote',
      body: null
    },
    {
      write: () => feed.closePoll('a1', 'p1'),
      method: 'POST',
      path: 'spaces/a1/feed/posts/p1/close',
      body: null
    },
    {
      write: () => feed.edit('a1', 'p1', 'Hi', []),
      method: 'PATCH',
      path: 'spaces/a1/feed/posts/p1',
      body: { body: 'Hi', mentions: [] }
    },
    {
      write: () => feed.remove('a1', 'p1'),
      method: 'DELETE',
      path: 'spaces/a1/feed/posts/p1',
      body: null
    },
    {
      write: () => feed.react('a1', 'p1', '👍'),
      method: 'PUT',
      path: `spaces/a1/feed/items/p1/reactions/${thumbsUp}`,
      body: null
    },
    {
      write: () => feed.unreact('a1', 'p1', '👍'),
      method: 'DELETE',
      path: `spaces/a1/feed/items/p1/reactions/${thumbsUp}`,
      body: null
    }
  ])('sends $method $path', async ({ write, method, path, body }) => {
    let sent: unknown = null
    fetchMock.mockImplementation(async request => {
      if (!(request instanceof Request)) throw new Error('not a Request')
      const text = await request.clone().text()
      sent = text ? JSON.parse(text) : null
      return method === 'POST' || method === 'PATCH'
        ? Response.json(post)
        : new Response(null, { status: 204 })
    })

    await write()

    expect(requested().method).toBe(method)
    expect(requested().url).toBe(`https://api.test/${path}`)
    expect(sent).toEqual(body)
  })
})
