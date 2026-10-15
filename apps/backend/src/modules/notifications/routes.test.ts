import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import { activityEvents } from '../feed/schema.ts'
import { configureHomeserver } from '../organizations/homeservers.ts'
import { homeservers, organizations } from '../organizations/schema.ts'
import { spaceMembers, spaces } from '../spaces/schema.ts'
import { registerNotificationRoutes } from './routes.ts'
import { notifications, notificationSettings } from './schema.ts'

const ALICE = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const BOB = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const DESIGN = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  await testDb.db.delete(notifications)
  await testDb.db.delete(notificationSettings)
  await testDb.db.delete(activityEvents)
})

async function notify(userId: string, title: string, minute: number) {
  const [event] = await testDb.db
    .insert(activityEvents)
    .values({
      source: 'drive',
      eventId: `${userId}-${title}`,
      organizationId: 'org-1',
      spaceId: DESIGN,
      type: 'com.twake.drive.file.shared',
      category: 'files',
      actor: { type: 'user', id: BOB, email: 'bob@example.com' },
      objectType: 'file',
      objectId: title,
      content: { object: { type: 'file', id: title, title } },
      time: new Date(`2026-10-05T09:${String(minute).padStart(2, '0')}:00Z`)
    })
    .returning({ id: activityEvents.id })
  if (!event) throw new Error('no event')
  const [row] = await testDb.db
    .insert(notifications)
    .values({
      organizationId: 'org-1',
      userId,
      type: 'invitation',
      spaceId: DESIGN,
      activityEventId: event.id,
      payload: {},
      createdAt: new Date(
        `2026-10-05T09:${String(minute).padStart(2, '0')}:00Z`
      )
    })
    .returning({ id: notifications.id })
  if (!row) throw new Error('no notification')
  return row.id
}

function setUp() {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    token =>
      token === 'alice'
        ? anIdentity({ userId: ALICE })
        : token === 'bob'
          ? anIdentity({ userId: BOB })
          : null,
    token =>
      token === 'tws_bot'
        ? aTokenCaller({ userId: ALICE, scopes: ['feed:read'] })
        : token === 'tws_harness'
          ? aTokenCaller({
              organizationId: 'acme',
              technical: true,
              scopes: ['notifications:write']
            })
          : token === 'tws_elsewhere'
            ? aTokenCaller({
                organizationId: 'other',
                technical: true,
                scopes: ['notifications:write']
              })
            : token === 'tws_member'
              ? aTokenCaller({
                  organizationId: 'acme',
                  userId: BOB,
                  scopes: ['notifications:write']
                })
              : token === 'tws_org'
                ? aTokenCaller({
                    organizationId: 'acme',
                    userId: null,
                    role: 'admin',
                    scopes: ['notifications:write']
                  })
                : null
  )
  registerNotificationRoutes(app, {
    db: testDb.db,
    authorize,
    localpart: 'uid'
  })
  return (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: object,
    token = 'alice'
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body && { payload: body })
    })
}

interface Page {
  notifications: { id: string; read: boolean; activity: { content: unknown } }[]
  unread: number
}

describe('GET /notifications', () => {
  it("lists the caller's notifications, newest first, with the activity", async () => {
    await notify(ALICE, 'brief', 1)
    await notify(ALICE, 'budget', 2)
    await notify(BOB, 'secret', 3)

    const response = await setUp()('GET', '/notifications')

    expect(response.statusCode).toBe(200)
    const page = response.json<Page>()
    expect(page.unread).toBe(2)
    expect(page.notifications).toMatchObject([
      {
        type: 'invitation',
        spaceId: DESIGN,
        read: false,
        activity: {
          type: 'com.twake.drive.file.shared',
          category: 'files',
          actor: { type: 'user', id: BOB },
          content: { object: { title: 'budget' } }
        }
      },
      { activity: { content: { object: { title: 'brief' } } } }
    ])
  })

  it('pages with the last id seen', async () => {
    await notify(ALICE, 'one', 1)
    await notify(ALICE, 'two', 2)
    await notify(ALICE, 'three', 3)
    const get = setUp()

    const first = (await get('GET', '/notifications?limit=2')).json<Page>()
    const last = first.notifications.at(-1)?.id ?? ''
    const second = (
      await get('GET', `/notifications?limit=2&before=${last}`)
    ).json<Page>()

    expect(first.notifications).toHaveLength(2)
    expect(second.notifications).toMatchObject([
      { activity: { content: { object: { title: 'one' } } } }
    ])
  })

  it('pages through notifications made at the same time without skipping any', async () => {
    for (const title of ['a', 'b', 'c', 'd', 'e']) await notify(ALICE, title, 1)
    const get = setUp()
    const seen: string[] = []

    let before = ''
    for (let page = 0; page < 3; page++) {
      const { notifications: rows } = (
        await get('GET', `/notifications?limit=2${before}`)
      ).json<Page>()
      seen.push(...rows.map(r => r.id))
      before = `&before=${rows.at(-1)?.id ?? ''}`
    }

    expect(new Set(seen).size).toBe(5)
    expect(seen).toHaveLength(5)
  })

  it('is for people signed in, not API tokens', async () => {
    const response = await setUp()(
      'GET',
      '/notifications',
      undefined,
      'tws_bot'
    )

    expect(response.statusCode).toBe(403)
  })
})

describe('marking as read', () => {
  it('marks one notification as read', async () => {
    const id = await notify(ALICE, 'brief', 1)
    await notify(ALICE, 'budget', 2)
    const call = setUp()

    const response = await call('POST', `/notifications/${id}/read`)

    expect(response.statusCode).toBe(204)
    const page = (await call('GET', '/notifications')).json<Page>()
    expect(page.unread).toBe(1)
    expect(page.notifications.find(n => n.id === id)?.read).toBe(true)
  })

  it("never marks someone else's notification", async () => {
    const id = await notify(BOB, 'secret', 1)

    const response = await setUp()('POST', `/notifications/${id}/read`)

    expect(response.statusCode).toBe(404)
  })

  it('marks all of them as read', async () => {
    await notify(ALICE, 'brief', 1)
    await notify(ALICE, 'budget', 2)
    await notify(BOB, 'secret', 3)
    const call = setUp()

    await call('POST', '/notifications/read')

    expect((await call('GET', '/notifications')).json<Page>().unread).toBe(0)
    expect(
      (await call('GET', '/notifications', undefined, 'bob')).json<Page>()
        .unread
    ).toBe(1)
  })
})

describe('settings', () => {
  it('reads the defaults, then the choices made', async () => {
    const call = setUp()

    const before = await call('GET', '/notifications/settings')
    const put = await call('PUT', '/notifications/settings', {
      invitation: false,
      space_change: true
    })
    const after = await call('GET', '/notifications/settings')

    expect(before.json()).toEqual({
      settings: {
        card_mention: true,
        assignment: true,
        invitation: true,
        attended_event_change: true,
        space_change: false,
        assistant_suggestion: true
      }
    })
    expect(put.statusCode).toBe(204)
    expect(after.json()).toMatchObject({
      settings: { invitation: false, space_change: true, card_mention: true }
    })
  })

  it('refuses an unknown type', async () => {
    const response = await setUp()('PUT', '/notifications/settings', {
      newsletter: true
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /notifications/suggestions', () => {
  const suggestion = {
    matrixUserId: '@alice:example.com',
    externalId: 'call-1',
    text: 'Free on Monday, plan the meeting?',
    pendingCallId: 'pc-1',
    matrixRoomId: '!room:example.com'
  }

  beforeEach(async () => {
    const { db } = testDb
    for (const table of [spaceMembers, spaces, organizations, homeservers]) {
      await db.delete(table)
    }
    await db
      .insert(organizations)
      .values({ organizationId: 'acme', domain: 'acme.example.com' })
    await configureHomeserver(db, {
      url: 'https://matrix.example.com',
      serverName: 'example.com'
    })
    const [hs] = await db.select({ id: homeservers.id }).from(homeservers)
    await db.update(organizations).set({ homeserverId: hs?.id ?? null })
    await db
      .insert(spaces)
      .values({ spaceId: DESIGN, organizationId: 'acme', name: 'Design' })
    await db.insert(spaceMembers).values({
      spaceId: DESIGN,
      userId: ALICE,
      username: 'alice',
      email: 'alice@acme.example.com',
      role: 'editor'
    })
  })

  it('creates a notification for the user and shows it in the list', async () => {
    const send = setUp()

    const created = await send(
      'POST',
      '/notifications/suggestions',
      suggestion,
      'tws_harness'
    )

    expect(created.statusCode).toBe(201)
    const listed = (await send('GET', '/notifications')).json<{
      notifications: { id: string; type: string; payload: unknown }[]
    }>()
    expect(listed.notifications).toMatchObject([
      {
        id: created.json<{ id: string }>().id,
        type: 'assistant_suggestion',
        payload: {
          text: suggestion.text,
          pendingCallId: 'pc-1',
          matrixRoomId: '!room:example.com'
        }
      }
    ])
  })

  it('answers the existing id for the same externalId', async () => {
    const send = setUp()
    const first = await send(
      'POST',
      '/notifications/suggestions',
      suggestion,
      'tws_harness'
    )
    const again = await send(
      'POST',
      '/notifications/suggestions',
      suggestion,
      'tws_harness'
    )

    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(await testDb.db.select().from(notifications)).toHaveLength(1)
  })

  it('needs the notifications:write scope', async () => {
    const send = setUp()
    for (const token of ['tws_bot', 'alice']) {
      const response = await send(
        'POST',
        '/notifications/suggestions',
        suggestion,
        token
      )
      expect(response.statusCode).toBe(403)
    }
  })

  it("is only for a technical account's token", async () => {
    const send = setUp()
    for (const token of ['tws_member', 'tws_org']) {
      const response = await send(
        'POST',
        '/notifications/suggestions',
        suggestion,
        token
      )
      expect(response.statusCode).toBe(403)
    }
    expect(await testDb.db.select().from(notifications)).toHaveLength(0)
  })

  it('refuses an unknown user, another homeserver and another organization with 404', async () => {
    const send = setUp()
    const bodies = [
      [{ ...suggestion, matrixUserId: '@nobody:example.com' }, 'tws_harness'],
      [{ ...suggestion, matrixUserId: '@alice:elsewhere.org' }, 'tws_harness'],
      [suggestion, 'tws_elsewhere']
    ] as const
    for (const [body, token] of bodies) {
      const response = await send(
        'POST',
        '/notifications/suggestions',
        body,
        token
      )
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({ error: 'unknown_user' })
    }
  })

  it('finds a member of several spaces, and no one when two members share the name', async () => {
    const SALES = '6a1f3c9e-2b7d-4e8a-b5c4-0d9e8f7a6b51'
    const send = setUp()
    await testDb.db
      .insert(spaces)
      .values({ spaceId: SALES, organizationId: 'acme', name: 'Sales' })
    await testDb.db.insert(spaceMembers).values({
      spaceId: SALES,
      userId: ALICE,
      username: 'alice',
      email: 'alice@acme.example.com',
      role: 'viewer'
    })
    const once = await send(
      'POST',
      '/notifications/suggestions',
      suggestion,
      'tws_harness'
    )
    await testDb.db.insert(spaceMembers).values({
      spaceId: SALES,
      userId: BOB,
      username: 'Alice',
      email: 'alice@other.example.com',
      role: 'viewer'
    })
    const twice = await send(
      'POST',
      '/notifications/suggestions',
      { ...suggestion, externalId: 'call-2' },
      'tws_harness'
    )

    expect(once.statusCode).toBe(201)
    expect(twice.statusCode).toBe(404)
  })

  it('refuses a bad body with 400', async () => {
    const response = await setUp()(
      'POST',
      '/notifications/suggestions',
      { ...suggestion, text: '' },
      'tws_harness'
    )
    expect(response.statusCode).toBe(400)
  })

  it('creates nothing when the user turned suggestions off', async () => {
    await testDb.db.insert(notificationSettings).values({
      userId: ALICE,
      type: 'assistant_suggestion',
      enabled: false
    })

    const response = await setUp()(
      'POST',
      '/notifications/suggestions',
      suggestion,
      'tws_harness'
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: null })
    expect(await testDb.db.select().from(notifications)).toHaveLength(0)
  })
})
