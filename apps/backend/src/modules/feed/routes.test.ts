import { pino } from 'pino'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { createServer } from '../../infra/http.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import type { TokenCaller } from '../tokens/authenticator.ts'
import { listenInMemory } from '../live/testing.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { registerFeedRoutes } from './routes.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPosts,
  feedReads
} from './schema.ts'

const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const OTHER = '6a1f0d2c-3b4e-4c5d-8e6f-7a8b9c0d1e2f'
const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const CAROL = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const DAN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'

const live = vi.fn()

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
  await listenInMemory({ send: live, closeSession: vi.fn() })
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  live.mockClear()
  const { db } = testDb
  await db.delete(feedItemReactions)
  await db.delete(feedPosts)
  await db.delete(feedReads)
  await db.delete(feedCards)
  await db.delete(activityEvents)
  await db.delete(spaceMembers)
  await db.delete(spaces)
  await db.insert(spaces).values([
    { spaceId: DESIGN, organizationId: 'org-1', name: 'Design' },
    { spaceId: OTHER, organizationId: 'org-1', name: 'Other' }
  ])
  await db.insert(spaceMembers).values([
    {
      spaceId: DESIGN,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice Martin',
      role: 'editor'
    },
    {
      spaceId: DESIGN,
      userId: BOB,
      username: 'bob',
      email: 'bob@example.com',
      role: 'viewer'
    },
    {
      spaceId: DESIGN,
      userId: CAROL,
      username: 'carol',
      email: 'carol@example.com',
      role: 'admin'
    },
    {
      spaceId: OTHER,
      userId: DAN,
      username: 'dan',
      email: 'dan@example.com',
      role: 'admin'
    }
  ])
})

const USERS: Record<string, string> = {
  alice: ALICE,
  bob: BOB,
  carol: CAROL,
  dan: DAN
}

function setUp(tokenCaller: TokenCaller | null = null) {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    token => {
      const userId = USERS[token]
      return userId ? anIdentity({ userId, organizationId: 'org-1' }) : null
    },
    token => (token === 'tws_bot' ? tokenCaller : null)
  )
  registerFeedRoutes(app, { db: testDb.db, authorize })
  return (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    token = 'alice',
    body?: object
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body && { payload: body })
    })
}

async function aCard(
  objectId: string,
  time: string,
  options: {
    category?: 'files' | 'events'
    spaceId?: string
    state?: unknown
    type?: string
    files?: unknown
    samples?: unknown
  } = {}
) {
  const spaceId = options.spaceId ?? DESIGN
  const [event] = await testDb.db
    .insert(activityEvents)
    .values({
      source: 'twake://drive',
      eventId: `${spaceId}-${objectId}-${time}`,
      organizationId: 'org-1',
      spaceId,
      type: options.type ?? 'com.twake.drive.file.created.v1',
      category: options.category ?? 'files',
      actor: { type: 'user', id: ALICE, email: 'alice@example.com' },
      objectType: 'file',
      objectId,
      content: {
        object: {
          type: 'file',
          id: objectId,
          title: `${objectId}.odt`,
          container: { kind: 'drive', id: 'drive-1' }
        },
        preview: 'First draft',
        state: options.state,
        files: options.files,
        samples: options.samples
      },
      time: new Date(time)
    })
    .returning({ id: activityEvents.id })
  if (!event) throw new Error('no event')
  const [card] = await testDb.db
    .insert(feedCards)
    .values({
      spaceId,
      objectType: 'file',
      objectId,
      category: options.category ?? 'files',
      time: new Date(time),
      latestEventId: event.id,
      latestTime: new Date(time)
    })
    .returning({ id: feedCards.id })
  if (!card) throw new Error('no card')
  return card.id
}

async function aPost(body: string, time: string, authorId = ALICE) {
  const [post] = await testDb.db
    .insert(feedPosts)
    .values({ spaceId: DESIGN, authorId, body, time: new Date(time) })
    .returning({ id: feedPosts.id })
  if (!post) throw new Error('no post')
  return post.id
}

interface Item {
  id: string
  kind: string
  reactions: { key: string; userIds: string[] }[]
}
interface Page {
  items: Item[]
  next: string | null
}

describe('GET /spaces/:spaceId/feed', () => {
  it('lists cards and posts newest first, with names and reactions', async () => {
    const card = await aCard('roadmap', '2026-10-05T09:00:00Z')
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')
    await testDb.db.insert(feedItemReactions).values([
      {
        itemId: card,
        spaceId: DESIGN,
        userId: BOB,
        key: '👍',
        createdAt: new Date('2026-10-05T11:00:00Z')
      },
      {
        itemId: card,
        spaceId: DESIGN,
        userId: CAROL,
        key: '👍',
        createdAt: new Date('2026-10-05T11:05:00Z')
      }
    ])

    const response = await setUp()('GET', `/spaces/${DESIGN}/feed`, 'bob')

    expect(response.statusCode).toBe(200)
    expect(response.json<Page>()).toEqual({
      items: [
        {
          id: post,
          kind: 'post',
          category: 'messages',
          time: '2026-10-05T10:00:00.000Z',
          updatedAt: '2026-10-05T10:00:00.000Z',
          author: { type: 'user', id: ALICE, name: 'Alice Martin' },
          body: 'Hello team',
          editedAt: null,
          reactions: []
        },
        {
          id: card,
          kind: 'card',
          category: 'files',
          time: '2026-10-05T09:00:00.000Z',
          updatedAt: '2026-10-05T09:00:00.000Z',
          type: 'com.twake.drive.file.created.v1',
          actor: { type: 'user', id: ALICE, name: 'Alice Martin' },
          object: {
            type: 'file',
            id: 'roadmap',
            title: 'roadmap.odt',
            container: { kind: 'drive', id: 'drive-1' }
          },
          preview: 'First draft',
          state: {},
          files: null,
          reactions: [{ key: '👍', userIds: [BOB, CAROL] }]
        }
      ],
      next: null
    })
  })

  it('searches card titles and previews and post bodies with q', async () => {
    const roadmap = await aCard('Roadmap', '2026-10-05T09:00:00Z')
    await aCard('budget', '2026-10-05T09:30:00Z')
    const post = await aPost('The ROADMAP is out', '2026-10-05T10:00:00Z')
    await aPost('Lunch?', '2026-10-05T11:00:00Z')
    const get = setUp()

    const byTitle = await get('GET', `/spaces/${DESIGN}/feed?q=roadmap`)
    const byPreview = await get('GET', `/spaces/${DESIGN}/feed?q=first%20draft`)
    const wildcard = await get('GET', `/spaces/${DESIGN}/feed?q=%25`)

    expect(byTitle.json<Page>().items.map(i => i.id)).toEqual([post, roadmap])
    expect(byPreview.json<Page>().items.map(i => i.kind)).toEqual([
      'card',
      'card'
    ])
    expect(wildcard.json<Page>().items).toEqual([])
  })

  it('pages with the next cursor', async () => {
    await aCard('one', '2026-10-05T09:00:00Z')
    await aPost('two', '2026-10-05T10:00:00Z')
    await aCard('three', '2026-10-05T11:00:00Z')
    const get = setUp()

    const first = (
      await get('GET', `/spaces/${DESIGN}/feed?limit=2`)
    ).json<Page>()
    const second = (
      await get(
        'GET',
        `/spaces/${DESIGN}/feed?limit=2&before=${first.next ?? ''}`
      )
    ).json<Page>()

    expect(first.items).toHaveLength(2)
    expect(first.next).toEqual(expect.any(String))
    expect(second).toMatchObject({
      items: [{ object: { id: 'one' } }],
      next: null
    })
  })

  it('filters by category, posts counting as messages', async () => {
    await aCard('roadmap', '2026-10-05T09:00:00Z')
    await aCard('meeting', '2026-10-05T09:30:00Z', { category: 'events' })
    await aPost('Hello', '2026-10-05T10:00:00Z')
    const get = setUp()

    const events = await get('GET', `/spaces/${DESIGN}/feed?category=events`)
    const messages = await get(
      'GET',
      `/spaces/${DESIGN}/feed?category=messages`
    )

    expect(events.json<Page>().items).toMatchObject([
      { object: { id: 'meeting' } }
    ])
    expect(messages.json<Page>().items).toMatchObject([{ body: 'Hello' }])
  })

  it("leaves out another space's items", async () => {
    await aCard('secret', '2026-10-05T09:00:00Z', { spaceId: OTHER })

    const response = await setUp()('GET', `/spaces/${DESIGN}/feed`)

    expect(response.json<Page>().items).toEqual([])
  })

  it('answers 404 to someone outside the space', async () => {
    const response = await setUp()('GET', `/spaces/${DESIGN}/feed`, 'dan')

    expect(response.statusCode).toBe(404)
  })

  it('refuses an invalid cursor or category', async () => {
    const get = setUp()

    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?before=nope`)).statusCode
    ).toBe(400)
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?category=chat`)).statusCode
    ).toBe(400)
  })

  it('shows a deleted author as a deleted user', async () => {
    await testDb.db.insert(feedPosts).values({
      spaceId: DESIGN,
      authorId: null,
      body: 'Bye',
      time: new Date()
    })

    const response = await setUp()('GET', `/spaces/${DESIGN}/feed`)

    expect(response.json<Page>().items).toMatchObject([
      { author: { type: 'deleted_user' } }
    ])
  })
})

describe('with an API token', () => {
  const bot = (overrides: Partial<TokenCaller> = {}) =>
    setUp(aTokenCaller({ userId: BOB, scopes: ['feed:read'], ...overrides }))

  it('reads the feed of a space its account is in, given feed:read', async () => {
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')

    const feed = await bot()('GET', `/spaces/${DESIGN}/feed`, 'tws_bot')
    const item = await bot()(
      'GET',
      `/spaces/${DESIGN}/feed/items/${post}`,
      'tws_bot'
    )

    expect(feed.json<Page>().items.map(i => i.id)).toEqual([post])
    expect(item.statusCode).toBe(200)
  })

  it('needs feed:read and a space the token covers', async () => {
    const noScope = await bot({ scopes: ['space:read'] })(
      'GET',
      `/spaces/${DESIGN}/feed`,
      'tws_bot'
    )
    const elsewhere = await bot({ spaceIds: [OTHER] })(
      'GET',
      `/spaces/${DESIGN}/feed`,
      'tws_bot'
    )

    expect(noScope.statusCode).toBe(403)
    expect(elsewhere.statusCode).toBe(404)
  })

  it('never posts or reacts', async () => {
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')
    const call = bot({ userId: ALICE })

    const posted = await call(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'from a bot' }
    )
    const reacted = await call(
      'PUT',
      `/spaces/${DESIGN}/feed/items/${post}/reactions/👍`,
      'tws_bot'
    )

    expect(posted.statusCode).toBe(403)
    expect(reacted.statusCode).toBe(403)
  })

  it('has no read marker', async () => {
    const call = bot({ userId: ALICE })

    const read = await call('GET', `/spaces/${DESIGN}/feed/read`, 'tws_bot')

    expect(read.statusCode).toBe(403)
  })
})

describe('/spaces/:spaceId/feed/read', () => {
  it('is null until the member marks a time, then moves forward only', async () => {
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/read`

    const before = await send('GET', url)
    const marked = await send('PUT', url, 'alice', {
      readAt: '2026-10-05T10:00:00.000Z'
    })
    await send('PUT', url, 'alice', { readAt: '2026-10-05T09:00:00.000Z' })
    const after = await send('GET', url)
    const bobs = await send('GET', url, 'bob')

    expect(before.json()).toEqual({ readAt: null })
    expect(marked.statusCode).toBe(204)
    expect(after.json()).toEqual({ readAt: '2026-10-05T10:00:00.000Z' })
    expect(bobs.json()).toEqual({ readAt: null })
  })

  it('takes a time to come as now', async () => {
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/read`

    await send('PUT', url, 'alice', { readAt: '2999-01-01T00:00:00.000Z' })
    const read = await send('GET', url)

    const { readAt } = read.json<{ readAt: string }>()
    expect(Date.parse(readAt)).toBeLessThanOrEqual(Date.now())
  })

  it('refuses a bad time, and someone outside the space', async () => {
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/read`

    const bad = await send('PUT', url, 'alice', { readAt: 'yesterday' })
    const outside = await send('PUT', url, 'dan', {
      readAt: '2026-10-05T10:00:00.000Z'
    })

    expect(bad.statusCode).toBe(400)
    expect(outside.statusCode).toBe(404)
  })
})

describe('GET /spaces/:spaceId/feed/items/:itemId', () => {
  it('returns one item of the space', async () => {
    const card = await aCard('roadmap', '2026-10-05T09:00:00Z')
    const get = setUp()

    const found = await get('GET', `/spaces/${DESIGN}/feed/items/${card}`)
    const elsewhere = await get(
      'GET',
      `/spaces/${OTHER}/feed/items/${card}`,
      'dan'
    )

    expect(found.json()).toMatchObject({ id: card, kind: 'card' })
    expect(elsewhere.statusCode).toBe(404)
  })

  it('answers an empty state for a state an app sent that is not an object', async () => {
    const card = await aCard('roadmap', '2026-10-05T09:00:00Z', {
      state: 'soon'
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({ state: {} })
  })

  const DIGEST = 'com.twake.drive.folder.changed.v1'

  it('answers the file counts and sample names of a folder digest', async () => {
    const card = await aCard('q4', '2026-10-05T09:00:00Z', {
      type: DIGEST,
      files: { created: 1200, updated: 3, deleted: 0 },
      samples: ['logo.svg', 'banner.png']
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({
      files: {
        created: 1200,
        updated: 3,
        deleted: 0,
        samples: ['logo.svg', 'banner.png']
      }
    })
  })

  it('reads a count an app sent that is not a whole number as 0', async () => {
    const card = await aCard('q4', '2026-10-05T09:00:00Z', {
      type: DIGEST,
      files: { created: '12', updated: -1, deleted: 2.5 },
      samples: ['logo.svg', 7]
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({
      files: { created: 0, updated: 0, deleted: 0, samples: ['logo.svg'] }
    })
  })

  it('keeps the first five sample names of a folder digest', async () => {
    const card = await aCard('q4', '2026-10-05T09:00:00Z', {
      type: DIGEST,
      files: { created: 6 },
      samples: ['a', 'b', 'c', 'd', 'e', 'f']
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({
      files: { samples: ['a', 'b', 'c', 'd', 'e'] }
    })
  })

  it('answers no file counts for an event that is not a folder digest', async () => {
    const card = await aCard('q4', '2026-10-05T09:00:00Z', {
      files: { created: 3 },
      samples: ['logo.svg']
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({ files: null })
  })
})

describe('posts', () => {
  it('lets an editor post, and tells the members', async () => {
    const response = await setUp()(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      { body: '  Kick-off at 10  ' }
    )

    expect(response.statusCode).toBe(201)
    const post = response.json<Item>()
    expect(post).toMatchObject({
      kind: 'post',
      body: 'Kick-off at 10',
      author: { id: ALICE }
    })
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledTimes(3)
    })
    expect(live).toHaveBeenCalledWith(BOB, 'feed', {
      spaceId: DESIGN,
      itemId: post.id,
      change: 'added'
    })
  })

  it('refuses a viewer, and an empty or too long body', async () => {
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/posts`

    expect((await send('POST', url, 'bob', { body: 'Hi' })).json()).toEqual({
      error: 'cannot_post'
    })
    expect((await send('POST', url, 'alice', { body: '   ' })).statusCode).toBe(
      400
    )
    expect(
      (await send('POST', url, 'alice', { body: 'a'.repeat(4001) })).statusCode
    ).toBe(400)
  })

  it('lets the author edit a post', async () => {
    const post = await aPost('Draft', '2026-10-05T10:00:00Z')

    const response = await setUp()(
      'PATCH',
      `/spaces/${DESIGN}/feed/posts/${post}`,
      'alice',
      { body: 'Final' }
    )

    expect(response.statusCode).toBe(200)
    const edited = response.json<{ body: string; editedAt: string | null }>()
    expect(edited).toMatchObject({
      body: 'Final',
      time: '2026-10-05T10:00:00.000Z'
    })
    expect(edited.editedAt).not.toBeNull()
  })

  it("refuses to edit or delete someone else's post, even for an admin", async () => {
    const post = await aPost('Mine', '2026-10-05T10:00:00Z')
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/posts/${post}`

    const edited = await send('PATCH', url, 'carol', { body: 'Theirs' })
    const deleted = await send('DELETE', url, 'carol')

    expect(edited.json()).toEqual({ error: 'not_author' })
    expect(deleted.statusCode).toBe(403)
  })

  it('deletes a post with its reactions', async () => {
    const post = await aPost('Oops', '2026-10-05T10:00:00Z')
    await testDb.db
      .insert(feedItemReactions)
      .values({ itemId: post, spaceId: DESIGN, userId: BOB, key: '😮' })

    const response = await setUp()(
      'DELETE',
      `/spaces/${DESIGN}/feed/posts/${post}`
    )

    expect(response.statusCode).toBe(204)
    expect(await testDb.db.select().from(feedPosts)).toEqual([])
    expect(await testDb.db.select().from(feedItemReactions)).toEqual([])
  })

  it('answers 404 to a card id on the post routes', async () => {
    const card = await aCard('roadmap', '2026-10-05T09:00:00Z')

    const response = await setUp()(
      'DELETE',
      `/spaces/${DESIGN}/feed/posts/${card}`
    )

    expect(response.statusCode).toBe(404)
  })
})

describe('reactions', () => {
  const reactions = () =>
    testDb.db
      .select({ userId: feedItemReactions.userId, key: feedItemReactions.key })
      .from(feedItemReactions)

  it('lets a viewer react once, and take it back', async () => {
    const card = await aCard('roadmap', '2026-10-05T09:00:00Z')
    const send = setUp()
    const url = `/spaces/${DESIGN}/feed/items/${card}/reactions/${encodeURIComponent('👍')}`

    expect((await send('PUT', url, 'bob')).statusCode).toBe(204)
    expect((await send('PUT', url, 'bob')).statusCode).toBe(204)
    expect(await reactions()).toEqual([{ userId: BOB, key: '👍' }])

    expect((await send('DELETE', url, 'bob')).statusCode).toBe(204)
    expect(await reactions()).toEqual([])
    // Once per member for the reaction and once for taking it back.
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledTimes(6)
    })
    expect(live).toHaveBeenCalledWith(ALICE, 'feed', {
      spaceId: DESIGN,
      itemId: card,
      change: 'changed'
    })
  })

  it("answers 404 for another space's item, and refuses a long key", async () => {
    const card = await aCard('secret', '2026-10-05T09:00:00Z', {
      spaceId: OTHER
    })
    const post = await aPost('Hi', '2026-10-05T10:00:00Z')
    const send = setUp()

    const elsewhere = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/items/${card}/reactions/ok`
    )
    const long = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/items/${post}/reactions/${'x'.repeat(17)}`
    )

    expect(elsewhere.statusCode).toBe(404)
    expect(long.statusCode).toBe(400)
  })
})
