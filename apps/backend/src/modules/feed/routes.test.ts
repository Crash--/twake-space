import { and, eq } from 'drizzle-orm'
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
import { outgoingActivity } from '../../events/schema.ts'
import { createServer } from '../../infra/http.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { fixedWindows, perHour } from '../auth/index.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import type { TokenCaller } from '../tokens/authenticator.ts'
import { apiTokens } from '../tokens/schema.ts'
import { listenInMemory } from '../live/testing.ts'
import { notifications } from '../notifications/schema.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { encodeCursor, type Order } from './items.ts'
import type { MentionLimiter } from './mentions.ts'
import { registerFeedRoutes } from './routes.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPollVotes,
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
  await db.delete(notifications)
  await db.delete(outgoingActivity)
  await db.delete(feedItemReactions)
  await db.delete(feedPosts)
  await db.delete(apiTokens)
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

function setUp(
  tokenCaller: TokenCaller | null = null,
  mentionLimiter: MentionLimiter = () => 0
) {
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
  registerFeedRoutes(app, { db: testDb.db, authorize, mentionLimiter })
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
    // The time of its latest event, when a later one changed it.
    updatedAt?: string
  } = {}
) {
  const spaceId = options.spaceId ?? DESIGN
  const latest = options.updatedAt ?? time
  const [event] = await testDb.db
    .insert(activityEvents)
    .values({
      source: 'twake://drive',
      eventId: `${spaceId}-${objectId}-${latest}`,
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
      time: new Date(latest)
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
      latestTime: new Date(latest)
    })
    .returning({ id: feedCards.id })
  if (!card) throw new Error('no card')
  return card.id
}

async function aPost(
  body: string,
  time: string,
  authorId = ALICE,
  pollOptions: string[] | null = null
) {
  const [post] = await testDb.db
    .insert(feedPosts)
    .values({
      spaceId: DESIGN,
      authorId,
      kind: pollOptions ? 'poll' : 'text',
      body,
      time: new Date(time),
      pollOptions
    })
    .returning({ id: feedPosts.id })
  if (!post) throw new Error('no post')
  return post.id
}

// The row behind aTokenCaller(), which names the posts it signs.
async function aToken() {
  await testDb.db.insert(apiTokens).values({
    id: aTokenCaller().tokenId,
    organizationId: 'org-1',
    ownerKind: 'account',
    accountId: ALICE,
    name: 'Assistant',
    tokenHash: 'hash',
    scopes: ['feed:write'],
    createdBy: ALICE
  })
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
          poll: null,
          approval: null,
          announcement: null,
          feedback: null,
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

  it('searches card titles and previews, post bodies and poll options with q', async () => {
    const roadmap = await aCard('Roadmap', '2026-10-05T09:00:00Z')
    await aCard('budget', '2026-10-05T09:30:00Z')
    const post = await aPost('The ROADMAP is out', '2026-10-05T10:00:00Z')
    await aPost('Lunch?', '2026-10-05T11:00:00Z')
    const poll = await aPost('Where?', '2026-10-05T12:00:00Z', ALICE, [
      'Room 4',
      'Cafeteria'
    ])
    const get = setUp()

    const byTitle = await get('GET', `/spaces/${DESIGN}/feed?q=roadmap`)
    const byPreview = await get('GET', `/spaces/${DESIGN}/feed?q=first%20draft`)
    const byOption = await get('GET', `/spaces/${DESIGN}/feed?q=CAFET`)
    const wildcard = await get('GET', `/spaces/${DESIGN}/feed?q=%25`)

    expect(byOption.json<Page>().items.map(i => i.id)).toEqual([poll])
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

  it('lists the items active since an instant, newest activity first', async () => {
    const roadmap = await aCard('roadmap', '2026-09-28T09:00:00Z', {
      updatedAt: '2026-10-05T12:00:00Z'
    })
    await aCard('budget', '2026-09-28T10:00:00Z')
    const minutes = await aCard('minutes', '2026-10-05T11:00:00Z')
    const kickoff = await aCard('kickoff', '2026-10-05T00:00:00Z')
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')
    // A post counts from its time, its edits aside.
    await testDb.db.insert(feedPosts).values({
      spaceId: DESIGN,
      authorId: ALICE,
      body: 'Old news',
      time: new Date('2026-09-30T10:00:00Z'),
      editedAt: new Date('2026-10-05T13:00:00Z')
    })
    const get = setUp()
    const since = 'since=2026-10-05T00:00:00Z'

    const all = await get('GET', `/spaces/${DESIGN}/feed?${since}`)
    const files = await get(
      'GET',
      `/spaces/${DESIGN}/feed?${since}&category=files`
    )
    const searched = await get('GET', `/spaces/${DESIGN}/feed?${since}&q=road`)

    expect(all.statusCode).toBe(200)
    expect(all.json<Page>()).toMatchObject({
      items: [
        {
          id: roadmap,
          time: '2026-09-28T09:00:00.000Z',
          updatedAt: '2026-10-05T12:00:00.000Z'
        },
        { id: minutes },
        { id: post },
        { id: kickoff }
      ],
      next: null
    })
    expect(files.json<Page>().items.map(i => i.id)).toEqual([
      roadmap,
      minutes,
      kickoff
    ])
    expect(searched.json<Page>().items.map(i => i.id)).toEqual([roadmap])
  })

  it('pages the items active since an instant by their latest activity', async () => {
    const roadmap = await aCard('roadmap', '2026-09-28T09:00:00Z', {
      updatedAt: '2026-10-05T12:00:00Z'
    })
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')
    const minutes = await aCard('minutes', '2026-10-05T11:00:00Z')
    const get = setUp()
    const since = 'since=2026-10-05T00:00:00Z'

    const first = (
      await get('GET', `/spaces/${DESIGN}/feed?${since}&limit=2`)
    ).json<Page>()
    const second = (
      await get(
        'GET',
        `/spaces/${DESIGN}/feed?${since}&limit=2&before=${first.next ?? ''}`
      )
    ).json<Page>()

    expect(first.items.map(i => i.id)).toEqual([roadmap, minutes])
    expect(second).toMatchObject({ items: [{ id: post }], next: null })
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

  it('refuses an invalid cursor, category or since', async () => {
    const get = setUp()
    const cursor = (order: Order) =>
      encodeCursor({ order, time: new Date('2026-10-05T10:00:00Z'), id: ALICE })

    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?before=nope`)).statusCode
    ).toBe(400)
    // A cursor pages the order of its page alone.
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?before=${cursor('activity')}`))
        .statusCode
    ).toBe(400)
    expect(
      (
        await get(
          'GET',
          `/spaces/${DESIGN}/feed?since=2026-10-05T00:00:00Z&before=${cursor('time')}`
        )
      ).statusCode
    ).toBe(400)
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?since=0000-01-01T00:00:00Z`))
        .statusCode
    ).toBe(400)
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?category=chat`)).statusCode
    ).toBe(400)
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?since=2026-10-05T00:00:00`))
        .statusCode
    ).toBe(400)
    expect(
      (await get('GET', `/spaces/${DESIGN}/feed?since=yesterday`)).statusCode
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

  it('posts only with feed:write, and never reacts or votes', async () => {
    const post = await aPost('Hello team', '2026-10-05T10:00:00Z')
    const poll = await aPost('Lunch?', '2026-10-05T11:00:00Z', ALICE, [
      'Yes',
      'No'
    ])
    const voted = await bot({ userId: ALICE, scopes: ['feed:write'] })(
      'PUT',
      `/spaces/${DESIGN}/feed/posts/${poll}/vote`,
      'tws_bot',
      { option: 0 }
    )
    expect(voted.statusCode).toBe(403)

    const posted = await bot({ userId: ALICE })(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'from a bot' }
    )
    const reacted = await bot({ userId: ALICE, scopes: ['feed:write'] })(
      'PUT',
      `/spaces/${DESIGN}/feed/items/${post}/reactions/👍`,
      'tws_bot'
    )

    expect(posted.statusCode).toBe(403)
    expect(reacted.statusCode).toBe(403)
  })

  it('signs its posts with its own name, never its account', async () => {
    await aToken()
    const call = bot({ userId: ALICE, scopes: ['feed:write'] })

    const posted = await call(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'Standup notes' }
    )

    expect(posted.statusCode).toBe(201)
    expect(posted.json()).toMatchObject({
      kind: 'post',
      body: 'Standup notes',
      author: { type: 'token', id: aTokenCaller().tokenId, name: 'Assistant' }
    })
    expect(
      await testDb.db
        .select({ authorId: feedPosts.authorId })
        .from(feedPosts)
        .where(eq(feedPosts.id, posted.json<{ id: string }>().id))
    ).toEqual([{ authorId: null }])
  })

  it('publishes a poll and closes its own', async () => {
    await aToken()
    const call = bot({ userId: ALICE, scopes: ['feed:write'] })
    const posted = await call(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'Lunch?', poll: { options: ['Pizza', 'Sushi'] } }
    )
    const { id } = posted.json<{ id: string }>()

    const closed = await call(
      'POST',
      `/spaces/${DESIGN}/feed/posts/${id}/close`,
      'tws_bot'
    )

    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toMatchObject({
      author: { type: 'token' },
      poll: { closedAt: expect.any(String) as string }
    })
  })

  it('posts where its account or its own role may', async () => {
    await aToken()
    const post = (overrides: Partial<TokenCaller>) =>
      bot({ scopes: ['feed:write'], ...overrides })(
        'POST',
        `/spaces/${DESIGN}/feed/posts`,
        'tws_bot',
        { body: 'Hi' }
      )

    const viewer = await post({ userId: BOB })
    const outside = await post({ userId: DAN })
    const elsewhere = await post({ userId: ALICE, spaceIds: [OTHER] })
    const orgViewer = await post({ userId: null, role: 'viewer' })
    const orgEditor = await post({ userId: null, role: 'editor' })

    expect(viewer.json()).toEqual({ error: 'cannot_post' })
    expect(outside.statusCode).toBe(404)
    expect(elsewhere.statusCode).toBe(404)
    expect(orgViewer.json()).toEqual({ error: 'cannot_post' })
    expect(orgEditor.statusCode).toBe(201)
  })

  it("leaves its posts to its account's person, even once revoked", async () => {
    await aToken()
    const posted = await bot({ userId: ALICE, scopes: ['feed:write'] })(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'Oops' }
    )
    const post = `/spaces/${DESIGN}/feed/posts/${posted.json<{ id: string }>().id}`
    await testDb.db.update(apiTokens).set({ revokedAt: new Date() })
    const call = setUp()

    const byCarol = await call('DELETE', post, 'carol')
    const byAlice = await call('DELETE', post, 'alice')

    expect(byCarol.json()).toEqual({ error: 'not_author' })
    expect(byAlice.statusCode).toBe(204)
  })

  it('edits and deletes its own posts only', async () => {
    await aToken()
    const call = bot({ userId: ALICE, scopes: ['feed:write'] })
    const mine = (
      await call('POST', `/spaces/${DESIGN}/feed/posts`, 'tws_bot', {
        body: 'Draft'
      })
    ).json<{ id: string }>().id
    const alices = await aPost('Hello team', '2026-10-05T10:00:00Z')
    const posts = `/spaces/${DESIGN}/feed/posts`

    const byCarol = await call('PATCH', `${posts}/${mine}`, 'carol', {
      body: 'Taken over'
    })
    const onAlices = await call('PATCH', `${posts}/${alices}`, 'tws_bot', {
      body: 'Taken over'
    })
    const edited = await call('PATCH', `${posts}/${mine}`, 'tws_bot', {
      body: 'Final'
    })
    const deleted = await call('DELETE', `${posts}/${mine}`, 'tws_bot')

    expect(byCarol.json()).toEqual({ error: 'not_author' })
    expect(onAlices.json()).toEqual({ error: 'not_author' })
    expect(edited.json()).toMatchObject({ body: 'Final' })
    expect(deleted.statusCode).toBe(204)
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

describe('GET /feed/unread', () => {
  async function aMention(
    userId: string,
    spaceId: string,
    { time = '2026-10-05T11:00:00Z', read = false } = {}
  ) {
    const [event] = await testDb.db
      .insert(activityEvents)
      .values({
        source: 'twake://drive',
        eventId: crypto.randomUUID(),
        organizationId: 'org-1',
        spaceId,
        type: 'com.twake.drive.file.updated.v1',
        category: 'files',
        actor: null,
        objectType: 'file',
        objectId: 'roadmap',
        content: {},
        time: new Date(time)
      })
      .returning({ id: activityEvents.id })
    if (!event) throw new Error('no event')
    await testDb.db.insert(notifications).values({
      organizationId: 'org-1',
      userId,
      type: 'card_mention',
      spaceId,
      activityEventId: event.id,
      payload: {},
      readAt: read ? new Date() : null
    })
  }

  it('counts per space the items and the unread mentions newer than the mark', async () => {
    await aCard('old', '2026-10-05T09:00:00Z', {
      updatedAt: '2026-10-05T13:00:00Z'
    })
    await aCard('new', '2026-10-05T11:00:00Z')
    await aPost('Hello team', '2026-10-05T12:00:00Z')
    await testDb.db.insert(feedReads).values([
      {
        spaceId: DESIGN,
        userId: ALICE,
        readAt: new Date('2026-10-05T10:00:00Z')
      },
      { spaceId: DESIGN, userId: BOB, readAt: new Date('2026-10-05T12:00:00Z') }
    ])
    await aMention(ALICE, DESIGN)
    await aMention(ALICE, DESIGN, { time: '2026-10-05T09:30:00Z' })
    await aMention(ALICE, DESIGN, { read: true })
    await aMention(BOB, DESIGN, { read: true })
    const get = setUp()

    const alice = await get('GET', '/feed/unread')
    const bob = await get('GET', '/feed/unread', 'bob')
    const carol = await get('GET', '/feed/unread', 'carol')

    expect(alice.json()).toEqual({
      spaces: [{ spaceId: DESIGN, items: 2, mentions: 1 }]
    })
    expect(bob.json()).toEqual({ spaces: [] })
    expect(carol.json()).toEqual({ spaces: [] })
  })

  it('counts only the mentions of a feed never opened, in active spaces', async () => {
    await testDb.db.insert(spaceMembers).values({
      spaceId: OTHER,
      userId: ALICE,
      username: 'alice',
      email: 'alice@example.com',
      role: 'viewer'
    })
    await aCard('roadmap', '2026-10-05T11:00:00Z', { spaceId: OTHER })
    await aMention(ALICE, OTHER)
    await aMention(ALICE, DESIGN)
    await testDb.db
      .update(spaces)
      .set({ state: 'archived' })
      .where(eq(spaces.spaceId, DESIGN))
    const get = setUp()

    const unread = await get('GET', '/feed/unread')

    expect(unread.json()).toEqual({
      spaces: [{ spaceId: OTHER, items: 0, mentions: 1 }]
    })
  })

  it('leaves out the spaces of another organization', async () => {
    await testDb.db
      .update(spaces)
      .set({ organizationId: 'org-2' })
      .where(eq(spaces.spaceId, DESIGN))
    await aMention(ALICE, DESIGN)
    const get = setUp()

    const unread = await get('GET', '/feed/unread')

    expect(unread.json()).toEqual({ spaces: [] })
  })

  it('is for people only', async () => {
    const call = setUp(aTokenCaller({ userId: ALICE, scopes: ['feed:read'] }))

    const unread = await call('GET', '/feed/unread', 'tws_bot')

    expect(unread.statusCode).toBe(403)
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

  it('answers no file counts for a folder digest whose counts are not an object', async () => {
    const card = await aCard('q4', '2026-10-05T09:00:00Z', {
      type: DIGEST,
      files: [3],
      samples: 'logo.svg'
    })

    const found = await setUp()('GET', `/spaces/${DESIGN}/feed/items/${card}`)

    expect(found.json()).toMatchObject({ files: null })
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

  it('lets an author made a viewer take their post down, not edit it', async () => {
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', BOB, ['A', 'B'])
    const post = `/spaces/${DESIGN}/feed/posts/${poll}`
    const call = setUp()

    const edited = await call('PATCH', post, 'bob', { body: 'Taken over' })
    const closed = await call('POST', `${post}/close`, 'bob')
    const deleted = await call('DELETE', post, 'bob')

    expect(edited.json()).toEqual({ error: 'cannot_post' })
    expect(closed.statusCode).toBe(200)
    expect(deleted.statusCode).toBe(204)
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

describe('mentions', () => {
  const mentioned = () =>
    testDb.db
      .select({ userId: notifications.userId, type: notifications.type })
      .from(notifications)
  const outgoing = async () =>
    (await testDb.db.select().from(outgoingActivity)).map(row => row.event)

  it('notifies the members a post mentions and publishes each mention', async () => {
    const send = setUp()

    const response = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      { body: '@Bob can you review?', mentions: [BOB, ALICE, DAN] }
    )

    expect(response.statusCode).toBe(201)
    const post = response.json<Item>()
    expect(await mentioned()).toEqual([{ userId: BOB, type: 'card_mention' }])
    const [event, ...others] = await outgoing()
    expect(others).toEqual([])
    expect(event).toEqual({
      specversion: '1.0',
      id: expect.any(String) as string,
      source: 'twake://space',
      type: 'com.twake.space.post.mentioned.v1',
      time: expect.any(String) as string,
      twakeorg: 'org-1',
      twakeactorid: ALICE,
      twakeactor: 'alice@example.com',
      data: {
        object: {
          type: 'post',
          id: post.id,
          title: 'Design',
          space: { id: DESIGN, name: 'Design' }
        },
        preview: '@Bob can you review?',
        recipients: [
          { uuid: BOB, email: 'bob@example.com', reason: 'mentioned' }
        ]
      }
    })
    const feed = await send('GET', `/spaces/${DESIGN}/feed`, 'bob')
    expect(feed.json<Page>().items.map(item => item.id)).toEqual([post.id])
    const unread = await send('GET', '/feed/unread', 'bob')
    expect(unread.json()).toEqual({
      spaces: [{ spaceId: DESIGN, items: 0, mentions: 1 }]
    })
  })

  const spentOnBob = (): MentionLimiter => {
    const limiter = fixedWindows()
    for (let i = 0; i < 20; i++) {
      void limiter(`mention:${ALICE}:${BOB}`, perHour(20))
    }
    return key => limiter(key, perHour(20))
  }

  it('stops notifying a member after 20 mentions by one author in an hour', async () => {
    const send = setUp(null, spentOnBob())

    const response = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      {
        body: '@Bob @Carol',
        mentions: [BOB, CAROL]
      }
    )

    expect(response.statusCode).toBe(201)
    expect(await mentioned()).toEqual([{ userId: CAROL, type: 'card_mention' }])
    expect(
      (await outgoing()).map(event => event.data as { recipients: unknown })
    ).toMatchObject([{ recipients: [{ uuid: CAROL }] }])
  })

  it('still asks an approver past the mention limit', async () => {
    const send = setUp(null, spentOnBob())

    await send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'Approve the Q4 budget?',
      approval: { approvers: [BOB] }
    })

    expect(await mentioned()).toEqual([
      { userId: BOB, type: 'approval_request' }
    ])
  })

  it('cuts the preview to 280 characters', async () => {
    await setUp()('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'é'.repeat(300),
      mentions: [BOB]
    })

    const [event] = await outgoing()
    expect(event?.data).toMatchObject({ preview: 'é'.repeat(280) })
  })

  it('notifies on an edit only the members the post did not mention yet', async () => {
    const send = setUp()
    const created = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      {
        body: '@Bob',
        mentions: [BOB]
      }
    )
    const url = `/spaces/${DESIGN}/feed/posts/${created.json<Item>().id}`

    const edited = await send('PATCH', url, 'alice', {
      body: '@Bob @Carol',
      mentions: [BOB, CAROL]
    })

    expect(edited.statusCode).toBe(200)
    expect(await mentioned()).toEqual([
      { userId: BOB, type: 'card_mention' },
      { userId: CAROL, type: 'card_mention' }
    ])
    expect(
      (await outgoing()).map(event => event.data as { recipients: unknown })
    ).toMatchObject([
      { recipients: [{ uuid: BOB }] },
      { recipients: [{ uuid: CAROL }] }
    ])
  })

  it('takes the notifications back with the post', async () => {
    const send = setUp()
    const created = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      {
        body: '@Bob',
        mentions: [BOB]
      }
    )
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledWith(BOB, 'notification', {})
    })
    live.mockClear()

    await send(
      'DELETE',
      `/spaces/${DESIGN}/feed/posts/${created.json<Item>().id}`
    )

    expect(await mentioned()).toEqual([])
    expect(await outgoing()).toEqual([])
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledWith(BOB, 'notification', {})
    })
  })

  it('refuses mentions that are not ids', async () => {
    const response = await setUp()(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      { body: 'Hi', mentions: ['bob'] }
    )

    expect(response.statusCode).toBe(400)
  })

  it('lets an account token mention as its account, and no organization token', async () => {
    await aToken()
    const byAccount = await setUp(
      aTokenCaller({ userId: ALICE, scopes: ['feed:write'] })
    )('POST', `/spaces/${DESIGN}/feed/posts`, 'tws_bot', {
      body: '@Bob',
      mentions: [BOB]
    })
    const byOrganization = await setUp(
      aTokenCaller({ userId: null, role: 'editor', scopes: ['feed:write'] })
    )('POST', `/spaces/${DESIGN}/feed/posts`, 'tws_bot', {
      body: '@Bob',
      mentions: [BOB]
    })

    expect(byAccount.statusCode).toBe(201)
    expect(await mentioned()).toEqual([{ userId: BOB, type: 'card_mention' }])
    expect((await outgoing())[0]).toMatchObject({
      twakeactorid: ALICE,
      twakeactor: 'alice@example.com'
    })
    expect(byOrganization.statusCode).toBe(403)
    expect(byOrganization.json()).toEqual({ error: 'cannot_mention' })
  })
})

describe('polls', () => {
  interface Poll {
    options: { label: string; userIds: string[] }[]
    closedAt: string | null
  }
  const pollOf = async (send: ReturnType<typeof setUp>, postId: string) =>
    (await send('GET', `/spaces/${DESIGN}/feed/items/${postId}`)).json<{
      poll: Poll
    }>().poll

  it('lets an editor publish a poll, as a post with its options', async () => {
    const response = await setUp()(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      { body: 'Lunch where?', poll: { options: [' Pizza ', 'Sushi'] } }
    )

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      kind: 'post',
      category: 'messages',
      body: 'Lunch where?',
      poll: {
        kind: 'choice',
        options: [
          { label: 'Pizza', userIds: [] },
          { label: 'Sushi', userIds: [] }
        ],
        closedAt: null
      }
    })
  })

  it('refuses fewer than 2 or more than 10 options, empty or repeated ones', async () => {
    const send = setUp()
    const publish = (options: string[]) =>
      send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
        body: 'Lunch?',
        poll: { options }
      })

    expect((await publish(['Pizza'])).statusCode).toBe(400)
    expect(
      (await publish(Array.from({ length: 11 }, (_, i) => String(i))))
        .statusCode
    ).toBe(400)
    expect((await publish(['Pizza', '  '])).statusCode).toBe(400)
    expect((await publish(['Pizza', 'Pizza '])).statusCode).toBe(400)
    expect((await publish(['Pizza', 'pizza'])).statusCode).toBe(400)
    expect(
      (
        await send('POST', `/spaces/${DESIGN}/feed/posts`, 'bob', {
          body: 'Lunch?',
          poll: { options: ['Pizza', 'Sushi'] }
        })
      ).json()
    ).toEqual({ error: 'cannot_post' })
  })

  it('counts one vote per member, a viewer included, who can change it or take it back', async () => {
    // Four changes, told to the three members; a vote again for the same
    // option is no change.
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', ALICE, [
      'Pizza',
      'Sushi'
    ])
    const send = setUp()
    const vote = `/spaces/${DESIGN}/feed/posts/${poll}/vote`

    expect((await send('PUT', vote, 'bob', { option: 0 })).statusCode).toBe(204)
    await send('PUT', vote, 'carol', { option: 0 })
    await send('PUT', vote, 'bob', { option: 1 })
    expect((await send('PUT', vote, 'bob', { option: 1 })).statusCode).toBe(204)
    expect(await pollOf(send, poll)).toEqual({
      kind: 'choice',
      options: [
        { label: 'Pizza', userIds: [CAROL] },
        { label: 'Sushi', userIds: [BOB] }
      ],
      closedAt: null
    })

    expect((await send('DELETE', vote, 'bob')).statusCode).toBe(204)
    expect((await pollOf(send, poll)).options[1]?.userIds).toEqual([])
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledTimes(12)
    })
    expect(live).toHaveBeenCalledWith(ALICE, 'feed', {
      spaceId: DESIGN,
      itemId: poll,
      change: 'changed'
    })
  })

  it('refuses an option out of range, and a vote on a post with no poll', async () => {
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', ALICE, [
      'Pizza',
      'Sushi'
    ])
    const post = await aPost('Hello', '2026-10-05T11:00:00Z')
    const send = setUp()

    const outOfRange = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/posts/${poll}/vote`,
      'bob',
      { option: 2 }
    )
    const notAPoll = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/posts/${post}/vote`,
      'bob',
      { option: 0 }
    )
    const outside = await send(
      'PUT',
      `/spaces/${OTHER}/feed/posts/${poll}/vote`,
      'dan',
      { option: 0 }
    )

    expect(outOfRange.statusCode).toBe(400)
    expect(notAPoll.statusCode).toBe(404)
    expect(outside.statusCode).toBe(404)
  })

  it('lets the author close the poll, which then takes no vote', async () => {
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', ALICE, [
      'Pizza',
      'Sushi'
    ])
    const send = setUp()
    const close = `/spaces/${DESIGN}/feed/posts/${poll}/close`
    const vote = `/spaces/${DESIGN}/feed/posts/${poll}/vote`
    await send('PUT', vote, 'bob', { option: 0 })

    const byAdmin = await send('POST', close, 'carol')
    const closed = await send('POST', close, 'alice')
    const again = await send('POST', close, 'alice')

    expect(byAdmin.json()).toEqual({ error: 'not_author' })
    const { closedAt } = closed.json<{ poll: Poll }>().poll
    expect(closedAt).toEqual(expect.any(String))
    expect(again.json<{ poll: Poll }>().poll.closedAt).toBe(closedAt)
    expect((await send('PUT', vote, 'carol', { option: 1 })).json()).toEqual({
      error: 'poll_closed'
    })
    expect((await send('DELETE', vote, 'bob')).statusCode).toBe(409)
    expect((await pollOf(send, poll)).options[0]?.userIds).toEqual([BOB])
  })

  it('answers 404 to closing a post with no poll', async () => {
    const post = await aPost('Hello', '2026-10-05T10:00:00Z')

    const response = await setUp()(
      'POST',
      `/spaces/${DESIGN}/feed/posts/${post}/close`
    )

    expect(response.statusCode).toBe(404)
  })

  it('deletes a poll with its votes', async () => {
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', ALICE, [
      'Pizza',
      'Sushi'
    ])
    const send = setUp()
    await send('PUT', `/spaces/${DESIGN}/feed/posts/${poll}/vote`, 'bob', {
      option: 0
    })

    await send('DELETE', `/spaces/${DESIGN}/feed/posts/${poll}`)

    expect(await testDb.db.select().from(feedPollVotes)).toEqual([])
  })
})

describe('yes/no questions', () => {
  it('publishes a question with a yes and a no to vote for', async () => {
    const send = setUp()
    const created = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      {
        body: 'Ship on Friday?',
        poll: { kind: 'yes_no' }
      }
    )
    const id = created.json<Item>().id

    await send('PUT', `/spaces/${DESIGN}/feed/posts/${id}/vote`, 'bob', {
      option: 1
    })
    const outOfRange = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/posts/${id}/vote`,
      'carol',
      { option: 2 }
    )

    expect(created.statusCode).toBe(201)
    expect(outOfRange.statusCode).toBe(400)
    const item = await send('GET', `/spaces/${DESIGN}/feed/items/${id}`)
    expect(item.json()).toMatchObject({
      body: 'Ship on Friday?',
      poll: {
        kind: 'yes_no',
        options: [
          { label: 'yes', userIds: [] },
          { label: 'no', userIds: [BOB] }
        ],
        closedAt: null
      },
      approval: null
    })
  })

  it('refuses options sent with it, and a kind it does not know', async () => {
    const send = setUp()
    const publish = (poll: object) =>
      send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
        body: 'Ship?',
        poll
      })

    expect(
      (await publish({ kind: 'yes_no', options: ['Maybe', 'No'] })).statusCode
    ).toBe(400)
    expect((await publish({ kind: 'rating' })).statusCode).toBe(400)
    expect((await publish({})).statusCode).toBe(400)
  })
})

describe('approvals', () => {
  interface Approval {
    state: string
    approvers: {
      id: string
      name: string | null
      decision: string | null
      comment: string | null
      decidedAt: string | null
    }[]
    closedAt: string | null
  }
  const request = (send: ReturnType<typeof setUp>, approvers: string[]) =>
    send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'Approve the Q4 budget?',
      approval: { approvers }
    })
  const approvalOf = async (send: ReturnType<typeof setUp>, postId: string) =>
    (await send('GET', `/spaces/${DESIGN}/feed/items/${postId}`)).json<{
      approval: Approval
    }>().approval
  const decide = (
    send: ReturnType<typeof setUp>,
    postId: string,
    token: string,
    body: object
  ) =>
    send('PUT', `/spaces/${DESIGN}/feed/posts/${postId}/decision`, token, body)

  it('asks each approver, who is notified and gets the event', async () => {
    const send = setUp()

    const response = await request(send, [BOB, CAROL])

    expect(response.statusCode).toBe(201)
    const post = response.json<{ id: string; approval: Approval }>()
    expect(post.approval).toEqual({
      state: 'pending',
      approvers: [
        {
          id: BOB,
          name: 'bob',
          decision: null,
          comment: null,
          decidedAt: null
        },
        {
          id: CAROL,
          name: 'carol',
          decision: null,
          comment: null,
          decidedAt: null
        }
      ],
      closedAt: null
    })
    expect(
      await testDb.db
        .select({ userId: notifications.userId, type: notifications.type })
        .from(notifications)
        .orderBy(notifications.userId)
    ).toEqual([
      { userId: CAROL, type: 'approval_request' },
      { userId: BOB, type: 'approval_request' }
    ])
    const events = (await testDb.db.select().from(outgoingActivity)).map(
      row => row.event
    )
    expect(events).toHaveLength(2)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'com.twake.space.post.approval_requested.v1',
        twakeactorid: ALICE,
        data: {
          object: {
            type: 'post',
            id: post.id,
            title: 'Design',
            space: { id: DESIGN, name: 'Design' }
          },
          preview: 'Approve the Q4 budget?',
          recipients: [
            { uuid: BOB, email: 'bob@example.com', reason: 'approval' }
          ]
        }
      })
    )
    const unread = await send('GET', '/feed/unread', 'bob')
    expect(unread.json()).toEqual({
      spaces: [{ spaceId: DESIGN, items: 0, mentions: 1 }]
    })
  })

  it('refuses approvers outside the space, the author, none or repeated ones', async () => {
    const send = setUp()

    for (const approvers of [[DAN], [ALICE], [], [BOB, BOB]]) {
      expect((await request(send, approvers)).statusCode).toBe(400)
    }
    const both = await send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'Both?',
      poll: { kind: 'yes_no' },
      approval: { approvers: [BOB] }
    })
    expect(both.statusCode).toBe(400)
    expect(await testDb.db.select().from(feedPosts)).toEqual([])
  })

  it('needs a person to ask: no organization token', async () => {
    const response = await setUp(
      aTokenCaller({ userId: null, role: 'editor', scopes: ['feed:write'] })
    )('POST', `/spaces/${DESIGN}/feed/posts`, 'tws_bot', {
      body: 'Approve?',
      approval: { approvers: [BOB] }
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'cannot_request_approval' })
  })

  it('takes one decision per approver, with a comment, and sums them up', async () => {
    const send = setUp()
    const id = (await request(send, [BOB, CAROL])).json<Item>().id

    const approved = await decide(send, id, 'bob', {
      decision: 'approved',
      comment: ' Looks good '
    })
    const again = await decide(send, id, 'bob', { decision: 'rejected' })
    const outsider = await decide(send, id, 'alice', { decision: 'approved' })

    expect(approved.statusCode).toBe(204)
    expect(again.json()).toEqual({ error: 'already_decided' })
    expect(outsider.json()).toEqual({ error: 'not_approver' })
    const halfway = await approvalOf(send, id)
    expect(halfway.state).toBe('pending')
    expect(halfway.approvers[0]).toEqual({
      id: BOB,
      name: 'bob',
      decision: 'approved',
      comment: 'Looks good',
      decidedAt: expect.any(String) as string
    })
    await decide(send, id, 'carol', { decision: 'approved', comment: '' })
    const done = await approvalOf(send, id)
    expect(done.state).toBe('approved')
    expect(done.approvers[1]?.comment).toBeNull()
    expect(live).toHaveBeenCalledWith(ALICE, 'feed', {
      spaceId: DESIGN,
      itemId: id,
      change: 'changed'
    })
  })

  it('is rejected by one approver', async () => {
    const send = setUp()
    const id = (await request(send, [BOB, CAROL])).json<Item>().id

    await decide(send, id, 'carol', {
      decision: 'rejected',
      comment: 'Too high'
    })

    expect((await approvalOf(send, id)).state).toBe('rejected')
  })

  it('is approved without an approver who left the space undecided', async () => {
    const send = setUp()
    const id = (await request(send, [BOB, CAROL])).json<Item>().id
    await decide(send, id, 'bob', { decision: 'approved' })

    await testDb.db
      .delete(spaceMembers)
      .where(
        and(eq(spaceMembers.spaceId, DESIGN), eq(spaceMembers.userId, CAROL))
      )

    const approval = await approvalOf(send, id)
    expect(approval.state).toBe('approved')
    expect(approval.approvers[1]).toMatchObject({ id: CAROL, name: null })
  })

  it('notifies a mentioned approver once, of the request', async () => {
    const send = setUp()

    await send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'Approve the Q4 budget, @bob?',
      mentions: [BOB],
      approval: { approvers: [BOB] }
    })

    expect(
      await testDb.db
        .select({ userId: notifications.userId, type: notifications.type })
        .from(notifications)
    ).toEqual([{ userId: BOB, type: 'approval_request' }])
  })

  it('keeps the text the approvers decide on', async () => {
    const send = setUp()
    const id = (await request(send, [BOB])).json<Item>().id

    const edit = await send(
      'PATCH',
      `/spaces/${DESIGN}/feed/posts/${id}`,
      'alice',
      { body: 'Approve twice the Q4 budget?' }
    )

    expect(edit.statusCode).toBe(409)
    expect(edit.json()).toEqual({ error: 'cannot_edit_approval' })
  })

  it('takes no vote, and no decision once its author closed it', async () => {
    const send = setUp()
    const id = (await request(send, [BOB])).json<Item>().id

    const vote = await send(
      'PUT',
      `/spaces/${DESIGN}/feed/posts/${id}/vote`,
      'bob',
      { option: 0 }
    )
    const closed = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts/${id}/close`,
      'alice'
    )
    const late = await decide(send, id, 'bob', { decision: 'approved' })

    expect(vote.statusCode).toBe(404)
    expect(closed.json<{ approval: Approval }>().approval.closedAt).toEqual(
      expect.any(String)
    )
    expect(late.json()).toEqual({ error: 'poll_closed' })
  })

  it('answers 404 to a decision on a poll, and refuses an unknown decision', async () => {
    const poll = await aPost('Lunch?', '2026-10-05T10:00:00Z', ALICE, [
      'Pizza',
      'Sushi'
    ])
    const send = setUp()
    const id = (await request(send, [BOB])).json<Item>().id

    expect(
      (await decide(send, poll, 'bob', { decision: 'approved' })).statusCode
    ).toBe(404)
    expect(
      (await decide(send, id, 'bob', { decision: 'maybe' })).statusCode
    ).toBe(400)
  })

  it('takes the notifications back with the request', async () => {
    const send = setUp()
    const id = (await request(send, [BOB])).json<Item>().id

    await send('DELETE', `/spaces/${DESIGN}/feed/posts/${id}`)

    expect(await testDb.db.select().from(notifications)).toEqual([])
    expect(await testDb.db.select().from(outgoingActivity)).toEqual([])
  })
})

describe('announcements', () => {
  const announce = (send: ReturnType<typeof setUp>, body: string) =>
    send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body,
      announcement: true
    })
  const pinned = async (send: ReturnType<typeof setUp>) =>
    (await send('GET', `/spaces/${DESIGN}/feed/pinned`, 'bob'))
      .json<{ items: Item[] }>()
      .items.map(item => item.id)

  it('pins an announcement at the top, latest first, and in the feed', async () => {
    const send = setUp()
    await aPost('Hello', '2026-10-05T10:00:00Z')

    const first = await announce(send, 'Offsite on Friday')
    await testDb.db
      .update(feedPosts)
      .set({ pinnedAt: new Date('2026-10-01T00:00:00Z') })
      .where(eq(feedPosts.id, first.json<Item>().id))
    const second = (await announce(send, 'New office')).json<Item>().id

    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      announcement: { pinnedAt: expect.any(String) as string },
      poll: null
    })
    expect(await pinned(send)).toEqual([second, first.json<Item>().id])
    const page = await send('GET', `/spaces/${DESIGN}/feed`)
    expect(page.json<Page>().items).toHaveLength(3)
    expect(live).toHaveBeenCalled()
  })

  it('stays pinned until its author unpins it, and pins again', async () => {
    const send = setUp()
    const id = (await announce(send, 'Offsite')).json<Item>().id
    const url = `/spaces/${DESIGN}/feed/posts/${id}/pin`

    const byOther = await send('DELETE', url, 'carol')
    const unpinned = await send('DELETE', url)
    const left = await pinned(send)
    const again = await send('PUT', url)

    expect(byOther.statusCode).toBe(403)
    expect(unpinned.statusCode).toBe(200)
    expect(unpinned.json()).toMatchObject({ announcement: { pinnedAt: null } })
    expect(left).toEqual([])
    expect(again.statusCode).toBe(200)
    expect(await pinned(send)).toEqual([id])
  })

  it('cannot pin a post that is not an announcement', async () => {
    const send = setUp()
    const id = await aPost('Hello', '2026-10-05T10:00:00Z')

    const response = await send('PUT', `/spaces/${DESIGN}/feed/posts/${id}/pin`)

    expect(response.statusCode).toBe(404)
  })

  it('is refused to a viewer, and with a poll', async () => {
    const send = setUp()

    const byViewer = await send('POST', `/spaces/${DESIGN}/feed/posts`, 'bob', {
      body: 'Hi',
      announcement: true
    })
    const withPoll = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'alice',
      {
        body: 'Hi',
        announcement: true,
        poll: { kind: 'yes_no' }
      }
    )

    expect(byViewer.statusCode).toBe(403)
    expect(withPoll.statusCode).toBe(400)
  })
})

describe('feedback requests', () => {
  interface Feedback {
    count: number
    mine: string | null
    answers: { userId: string; name: string | null; text: string }[] | null
    closedAt: string | null
  }
  const ask = (send: ReturnType<typeof setUp>) =>
    send('POST', `/spaces/${DESIGN}/feed/posts`, 'alice', {
      body: 'How was the offsite?',
      feedback: true
    })
  const answer = (
    send: ReturnType<typeof setUp>,
    id: string,
    token: string,
    text: string
  ) => send('PUT', `/spaces/${DESIGN}/feed/posts/${id}/answer`, token, { text })
  const feedbackOf = async (
    send: ReturnType<typeof setUp>,
    id: string,
    token: string
  ) =>
    (await send('GET', `/spaces/${DESIGN}/feed/items/${id}`, token)).json<{
      feedback: Feedback
    }>().feedback

  it('shows the answers to its author, the count and their own to others', async () => {
    const send = setUp()
    const created = await ask(send)
    const id = created.json<Item>().id

    expect((await answer(send, id, 'bob', 'Great')).statusCode).toBe(204)
    await answer(send, id, 'carol', 'Too long')
    await answer(send, id, 'bob', 'Great, thanks')

    expect(created.json()).toMatchObject({
      feedback: { count: 0, mine: null, answers: [], closedAt: null }
    })
    expect(await feedbackOf(send, id, 'alice')).toMatchObject({
      count: 2,
      mine: null,
      answers: [
        { userId: CAROL, name: 'carol', text: 'Too long' },
        { userId: BOB, name: 'bob', text: 'Great, thanks' }
      ]
    })
    expect(await feedbackOf(send, id, 'carol')).toEqual({
      count: 2,
      mine: 'Too long',
      answers: null,
      closedAt: null
    })
    const page = await send('GET', `/spaces/${DESIGN}/feed`, 'bob')
    expect(page.json()).toMatchObject({
      items: [{ feedback: { count: 2, mine: 'Great, thanks', answers: null } }]
    })
  })

  it('takes no answer once closed, nor an empty one', async () => {
    const send = setUp()
    const id = (await ask(send)).json<Item>().id

    const empty = await answer(send, id, 'bob', '  ')
    const closed = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts/${id}/close`
    )
    const late = await answer(send, id, 'bob', 'Late')

    expect(empty.statusCode).toBe(400)
    expect(closed.json()).toMatchObject({
      feedback: { closedAt: expect.any(String) as string }
    })
    expect(late.statusCode).toBe(409)
  })

  it('takes no answer on a post that is not a feedback request', async () => {
    const send = setUp()
    const id = await aPost('Hello', '2026-10-05T10:00:00Z')

    expect((await answer(send, id, 'bob', 'Hi')).statusCode).toBe(404)
  })

  it('cannot be asked by a token', async () => {
    await aToken()
    const send = setUp(aTokenCaller({ userId: ALICE, scopes: ['feed:write'] }))

    const response = await send(
      'POST',
      `/spaces/${DESIGN}/feed/posts`,
      'tws_bot',
      { body: 'How was it?', feedback: true }
    )

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'cannot_ask_feedback' })
  })

  it("keeps the answers from its author's tokens", async () => {
    const send = setUp()
    const id = (await ask(send)).json<Item>().id
    await answer(send, id, 'bob', 'Great')
    await aToken()
    const bot = setUp(aTokenCaller({ userId: ALICE, scopes: ['feed:read'] }))

    expect(await feedbackOf(bot, id, 'tws_bot')).toMatchObject({
      count: 1,
      answers: null
    })
  })

  it('takes no answer from its author, and no edit', async () => {
    const send = setUp()
    const id = (await ask(send)).json<Item>().id

    const own = await answer(send, id, 'alice', 'Fine')
    const edited = await send(
      'PATCH',
      `/spaces/${DESIGN}/feed/posts/${id}`,
      'alice',
      { body: 'How was the trip?', mentions: [] }
    )

    expect(own.json()).toEqual({ error: 'cannot_answer_own' })
    expect(edited.json()).toEqual({ error: 'cannot_edit_feedback' })
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
