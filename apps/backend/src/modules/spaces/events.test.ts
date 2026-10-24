import { eq } from 'drizzle-orm'
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
import type { PlatformEvent } from '../../events/envelope.ts'
import { lastChanges } from '../../events/schema.ts'
import { MalformedEventError, NotYetKnownError } from '../../events/router.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import {
  activityEvents,
  feedCards,
  feedItemReactions,
  feedPosts,
  feedReads
} from '../feed/schema.ts'
import { notifications } from '../notifications/schema.ts'
import { apiTokens } from '../tokens/schema.ts'
import { spacePlatformRoutes } from './events.ts'
import {
  organizationMembers,
  spaceGroups,
  spaceMarks,
  spaceMembers,
  spaces
} from './schema.ts'

const SPACE_ID = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const JDOE_ID = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const ASMITH_ID = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const jdoe = {
  uuid: JDOE_ID,
  username: 'jdoe',
  email: 'jdoe@evilcorp.com',
  firstName: 'John',
  lastName: 'Doe',
  role: 'editor'
}

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
const log = pino({ level: 'silent' })
const warn = vi.spyOn(log, 'warn')

beforeEach(async () => {
  warn.mockClear()
  await testDb.db.delete(spaceMembers)
  await testDb.db.delete(spaceMarks)
  await testDb.db.delete(spaceGroups)
  await testDb.db.delete(spaces)
  await testDb.db.delete(lastChanges)
  await testDb.db.delete(organizationMembers)
})

function handle(routingKey: string, body: unknown) {
  const handler = spacePlatformRoutes.get(routingKey)
  if (!handler) throw new Error(`no handler for ${routingKey}`)
  const event: PlatformEvent = { routingKey, messageId: 'msg-1', body }
  return testDb.db.transaction(tx => handler(event, tx, log))
}

function created(overrides: Record<string, unknown> = {}) {
  return handle('twake.space.created', {
    organizationId: 'evilcorp123',
    id: SPACE_ID,
    name: 'Design Sprint',
    members: [jdoe],
    actor: 'admin@evilcorp.com',
    timestamp: '2026-10-05T09:12:44.512Z',
    ...overrides
  })
}

const readSpace = () =>
  testDb.db.select().from(spaces).where(eq(spaces.spaceId, SPACE_ID))
const readMembers = () =>
  testDb.db
    .select({
      userId: spaceMembers.userId,
      username: spaceMembers.username,
      email: spaceMembers.email,
      role: spaceMembers.role
    })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, SPACE_ID))
const readDisplayNames = async () =>
  new Map(
    (
      await testDb.db
        .select({
          userId: spaceMembers.userId,
          displayName: spaceMembers.displayName
        })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, SPACE_ID))
    ).map(m => [m.userId, m.displayName])
  )
const readGroups = () =>
  testDb.db
    .select({
      groupId: spaceGroups.groupId,
      name: spaceGroups.name,
      role: spaceGroups.role
    })
    .from(spaceGroups)
    .where(eq(spaceGroups.spaceId, SPACE_ID))

const DESIGNERS_ID = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'
const designers = { id: DESIGNERS_ID, name: 'Designers', role: 'viewer' }

describe('space events', () => {
  it('stores a created space with its members', async () => {
    await created()

    expect(await readSpace()).toMatchObject([
      { organizationId: 'evilcorp123', name: 'Design Sprint' }
    ])
    expect(await readMembers()).toEqual([
      {
        userId: JDOE_ID,
        username: 'jdoe',
        email: 'jdoe@evilcorp.com',
        role: 'editor'
      }
    ])
  })

  it('keeps who created a space, active', async () => {
    await created({ actor: 'Admin@EvilCorp.com' })

    expect(await readSpace()).toMatchObject([
      { state: 'active', createdBy: 'admin@evilcorp.com' }
    ])
  })

  it('names no creator for a write that names no person', async () => {
    await created({ actor: 'token:evilcorp123' })

    expect(await readSpace()).toMatchObject([{ createdBy: null }])
  })

  it('takes the creator from a replayed creation, and keeps the first one', async () => {
    await created({ actor: undefined })
    await created({ actor: 'admin@evilcorp.com' })
    await created({ actor: 'other@evilcorp.com' })

    expect(await readSpace()).toMatchObject([
      { createdBy: 'admin@evilcorp.com' }
    ])
  })

  it('changes nothing when a created space is replayed', async () => {
    await created()
    await created()

    expect(await readSpace()).toHaveLength(1)
    expect(await readMembers()).toHaveLength(1)
  })

  it('leaves an archived space archived when its creation is replayed, renamed or not', async () => {
    await created()
    await testDb.db
      .update(spaces)
      .set({ state: 'archived' })
      .where(eq(spaces.spaceId, SPACE_ID))

    await created()
    await created({
      name: 'Design Week',
      timestamp: '2026-10-05T10:00:00.000Z'
    })

    expect(await readSpace()).toMatchObject([{ state: 'archived' }])
  })

  it('names a member by their first and last name, if they have one', async () => {
    await created({
      members: [
        jdoe,
        { ...jdoe, uuid: ASMITH_ID, firstName: undefined, lastName: ' ' }
      ]
    })

    expect(await readDisplayNames()).toEqual(
      new Map([
        [JDOE_ID, 'John Doe'],
        [ASMITH_ID, null]
      ])
    )
  })

  it('keeps the last entry of a member listed twice', async () => {
    await created({ members: [jdoe, { ...jdoe, role: 'admin' }] })

    expect(await readMembers()).toMatchObject([{ role: 'admin' }])
  })

  it('renames a space', async () => {
    await created()
    await handle('twake.space.updated', {
      organizationId: 'evilcorp123',
      id: SPACE_ID,
      name: 'Design Week',
      timestamp: '2026-10-05T10:00:00.000Z'
    })

    expect(await readSpace()).toMatchObject([{ name: 'Design Week' }])
  })

  it('removes a deleted space, its members and their marks', async () => {
    await created()
    await testDb.db
      .insert(spaceMarks)
      .values({ spaceId: SPACE_ID, userId: JDOE_ID, pinnedAt: new Date() })
    await handle('twake.space.deleted', {
      organizationId: 'evilcorp123',
      id: SPACE_ID,
      timestamp: '2026-10-05T11:00:00.000Z'
    })

    expect(await readSpace()).toEqual([])
    expect(await readMembers()).toEqual([])
    expect(await testDb.db.select().from(spaceMarks)).toEqual([])
  })

  it('removes a deleted user and no one else', async () => {
    const otherSpace = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
    const other = { ...jdoe, uuid: '1679091c-5a88-4faf-afb5-e6087eb1b2dc' }
    await created()
    await created({ id: otherSpace, members: [other] })
    await handle('domain.user.deleted', {
      emitter: 'ldap-rest',
      type: 'user.deleted',
      uuid: JDOE_ID,
      userId: 'jdoe',
      internalEmail: 'jdoe@evilcorp.com',
      organizationId: 'evilcorp123',
      reason: 'user deleted'
    })

    expect(await readMembers()).toEqual([])
    expect(
      await testDb.db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, otherSpace))
    ).toHaveLength(1)
  })

  it("forgets a deleted user's pins and visits, and no one else's", async () => {
    const other = '1679091c-5a88-4faf-afb5-e6087eb1b2dc'
    await created()
    await testDb.db.insert(spaceMarks).values([
      { spaceId: SPACE_ID, userId: JDOE_ID, pinnedAt: new Date() },
      { spaceId: SPACE_ID, userId: other, openedAt: new Date() }
    ])
    await handle('domain.user.deleted', {
      emitter: 'ldap-rest',
      type: 'user.deleted',
      uuid: JDOE_ID,
      userId: 'jdoe',
      internalEmail: 'jdoe@evilcorp.com',
      organizationId: 'evilcorp123',
      reason: 'user deleted'
    })

    expect(
      (await testDb.db.select().from(spaceMarks)).map(m => m.userId)
    ).toEqual([other])
  })

  it('forgets that a deleted user created a space', async () => {
    await created({ actor: jdoe.email })

    await handle('domain.user.deleted', {
      emitter: 'ldap-rest',
      type: 'user.deleted',
      uuid: JDOE_ID,
      userId: 'jdoe',
      internalEmail: jdoe.email,
      organizationId: 'evilcorp123',
      reason: 'user deleted'
    })

    expect(await readSpace()).toMatchObject([{ createdBy: null }])
  })

  it('removes a deleted user sent without a uuid by their email', async () => {
    await created()
    await handle('domain.user.deleted', {
      emitter: 'ldap-rest',
      type: 'user.deleted',
      userId: 'jdoe',
      internalEmail: 'jdoe@evilcorp.com',
      organizationId: 'evilcorp123',
      reason: 'user deleted'
    })

    expect(await readMembers()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  describe('a deleted user', () => {
    const deleted = (body: Record<string, unknown>) =>
      handle('domain.user.deleted', {
        emitter: 'ldap-rest',
        type: 'user.deleted',
        userId: 'jdoe',
        internalEmail: 'jdoe@evilcorp.com',
        organizationId: 'evilcorp123',
        reason: 'user deleted',
        ...body
      })

    async function seed() {
      await created()
      const [event] = await testDb.db
        .insert(activityEvents)
        .values({
          source: 'twake://drive',
          eventId: 'e1',
          spaceId: SPACE_ID,
          type: 'com.twake.drive.file.created.v1',
          category: 'files',
          actor: { type: 'user', id: JDOE_ID, email: jdoe.email },
          objectType: 'file',
          objectId: 'f1',
          content: {},
          time: new Date()
        })
        .returning()
      if (!event) throw new Error('no event')
      await testDb.db.insert(feedCards).values({
        spaceId: SPACE_ID,
        objectType: 'folder',
        objectId: 'q4',
        memberId: JDOE_ID,
        category: 'files',
        time: event.time,
        latestEventId: event.id,
        latestTime: event.time
      })
      await testDb.db.insert(activityEvents).values({
        source: 'twake://calendar',
        eventId: 'e2',
        spaceId: SPACE_ID,
        type: 'com.twake.calendar.event.updated.v1',
        category: 'events',
        actor: { type: 'user', id: null, email: jdoe.email },
        objectType: 'event',
        objectId: 'ev1',
        content: {},
        time: new Date()
      })
      await testDb.db.insert(notifications).values({
        userId: JDOE_ID,
        type: 'card_mention',
        activityEventId: event.id,
        payload: {}
      })
      const [post] = await testDb.db
        .insert(feedPosts)
        .values({
          spaceId: SPACE_ID,
          authorId: JDOE_ID,
          body: 'Hello',
          time: new Date()
        })
        .returning({ id: feedPosts.id })
      if (!post) throw new Error('no post')
      await testDb.db.insert(feedItemReactions).values({
        itemId: post.id,
        spaceId: SPACE_ID,
        userId: JDOE_ID,
        key: '👍'
      })
      await testDb.db
        .insert(feedReads)
        .values({ spaceId: SPACE_ID, userId: JDOE_ID, readAt: new Date() })
    }

    beforeEach(async () => {
      await testDb.db.delete(notifications)
      await testDb.db.delete(activityEvents)
      await testDb.db.delete(feedPosts)
      await testDb.db.delete(feedItemReactions)
      await testDb.db.delete(feedReads)
    })

    it.each([
      ['their uuid', { uuid: JDOE_ID }],
      ['only their email', {}]
    ])(
      'drops their notifications and their name from events, sent with %s',
      async (_, body) => {
        await seed()

        await deleted(body)

        expect(await testDb.db.select().from(notifications)).toEqual([])
        expect(
          await testDb.db
            .select({ actor: activityEvents.actor })
            .from(activityEvents)
        ).toEqual([
          { actor: { type: 'deleted_user' } },
          { actor: { type: 'deleted_user' } }
        ])
        expect(
          await testDb.db
            .select({ authorId: feedPosts.authorId })
            .from(feedPosts)
        ).toEqual([{ authorId: null }])
        expect(await testDb.db.select().from(feedItemReactions)).toEqual([])
        expect(await testDb.db.select().from(feedReads)).toEqual([])
        const [card] = await testDb.db
          .select({ memberId: feedCards.memberId })
          .from(feedCards)
        expect(card?.memberId).toBeTruthy()
        expect(card?.memberId).not.toBe(JDOE_ID)
      }
    )

    it('drops the name of their tokens from their tokens posts', async () => {
      const [token] = await testDb.db
        .insert(apiTokens)
        .values({
          organizationId: 'evilcorp123',
          ownerKind: 'account',
          accountId: JDOE_ID,
          name: "John's assistant",
          tokenHash: 'hash',
          scopes: ['feed:write'],
          createdBy: JDOE_ID
        })
        .returning({ id: apiTokens.id })
      if (!token) throw new Error('no token')
      await testDb.db.insert(feedPosts).values({
        spaceId: SPACE_ID,
        authorTokenId: token.id,
        body: 'Standup notes',
        time: new Date()
      })

      await deleted({ uuid: JDOE_ID })

      expect(
        await testDb.db
          .select({ authorTokenId: feedPosts.authorTokenId })
          .from(feedPosts)
      ).toEqual([{ authorTokenId: null }])
    })
  })

  it('refuses a space event without a space id', async () => {
    await expect(created({ id: 'not-a-uuid' })).rejects.toBeInstanceOf(
      MalformedEventError
    )
  })
})

describe('member events', () => {
  const member = (routingKey: string, members: unknown[]) =>
    handle(routingKey, {
      organizationId: 'evilcorp123',
      id: SPACE_ID,
      members,
      actor: 'admin@evilcorp.com',
      timestamp: '2026-10-05T09:12:44.512Z'
    })
  const asmith = {
    ...jdoe,
    uuid: 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a',
    username: 'asmith',
    email: 'asmith@evilcorp.com'
  }

  it('adds a member with their role', async () => {
    await created()

    await member('twake.space.member.added', [{ ...asmith, role: 'viewer' }])

    expect(await readMembers()).toContainEqual({
      userId: asmith.uuid,
      username: 'asmith',
      email: 'asmith@evilcorp.com',
      role: 'viewer'
    })
  })

  it("changes a member's role", async () => {
    await created()

    await member('twake.space.member.role.changed', [
      { ...jdoe, role: 'admin' }
    ])

    expect(await readMembers()).toMatchObject([
      { username: 'jdoe', role: 'admin' }
    ])
  })

  it('keeps a member whose username changed as the same person', async () => {
    await created()

    await member('twake.space.member.role.changed', [
      { ...jdoe, username: 'john.doe', role: 'admin' }
    ])

    expect(await readMembers()).toMatchObject([
      { userId: JDOE_ID, username: 'john.doe', role: 'admin' }
    ])
  })

  it('removes a member', async () => {
    await created({ members: [jdoe, asmith] })

    await member('twake.space.member.removed', [jdoe])

    expect(await readMembers()).toMatchObject([{ username: 'asmith' }])
  })

  it("forgets the pins and visits of a member who leaves, and no one else's", async () => {
    await created({ members: [jdoe, asmith] })
    await testDb.db.insert(spaceMarks).values([
      { spaceId: SPACE_ID, userId: JDOE_ID, pinnedAt: new Date() },
      { spaceId: SPACE_ID, userId: asmith.uuid, openedAt: new Date() }
    ])

    await member('twake.space.member.removed', [jdoe])

    expect(
      (await testDb.db.select().from(spaceMarks)).map(m => m.userId)
    ).toEqual([asmith.uuid])
  })

  it('finds a member sent without a uuid by their email', async () => {
    await created()

    await member('twake.space.member.role.changed', [
      { ...jdoe, uuid: undefined, role: 'admin' }
    ])

    expect(await readMembers()).toMatchObject([
      { userId: JDOE_ID, role: 'admin' }
    ])
    expect(warn).toHaveBeenCalled()
  })

  it('skips a member sent without a uuid who is not in the copy', async () => {
    await created()

    await member('twake.space.member.added', [{ ...asmith, uuid: undefined }])

    expect(await readMembers()).toMatchObject([{ username: 'jdoe' }])
    expect(warn).toHaveBeenCalled()
  })

  it('removes a member sent with only an email', async () => {
    await created({ members: [jdoe, asmith] })

    await member('twake.space.member.removed', [{ email: jdoe.email }])

    expect(await readMembers()).toMatchObject([{ username: 'asmith' }])
  })

  it('refuses a removed member with neither a uuid nor an email', async () => {
    await expect(
      member('twake.space.member.removed', [{ username: 'jdoe' }])
    ).rejects.toBeInstanceOf(MalformedEventError)
  })

  it('refuses a member event without members', async () => {
    await expect(member('twake.space.member.added', [])).rejects.toBeInstanceOf(
      MalformedEventError
    )
  })
})

describe('group events', () => {
  const group = (routingKey: string, groups: unknown[]) =>
    handle(routingKey, {
      organizationId: 'evilcorp123',
      id: SPACE_ID,
      groups,
      actor: 'admin@evilcorp.com',
      timestamp: '2026-10-05T09:12:44.512Z'
    })

  it('stores the linked groups of a created space', async () => {
    await created({ groups: [designers] })

    expect(await readGroups()).toEqual([
      { groupId: DESIGNERS_ID, name: 'Designers', role: 'viewer' }
    ])
  })

  it('links a group with its role', async () => {
    await created()

    await group('twake.space.group.linked', [designers])

    expect(await readGroups()).toMatchObject([{ groupId: DESIGNERS_ID }])
  })

  it("changes a linked group's role", async () => {
    await created({ groups: [designers] })

    await group('twake.space.group.role.changed', [
      { ...designers, role: 'editor' }
    ])

    expect(await readGroups()).toMatchObject([{ role: 'editor' }])
  })

  it('unlinks a group', async () => {
    await created({ groups: [designers] })

    await group('twake.space.group.unlinked', [{ id: DESIGNERS_ID }])

    expect(await readGroups()).toEqual([])
  })

  it('follows the rename of a linked group', async () => {
    await created({ groups: [designers] })

    await handle('b2b.group.updated', {
      organizationId: 'evilcorp123',
      id: DESIGNERS_ID,
      name: 'Product design',
      timestamp: '2026-10-05T09:12:44.512Z'
    })

    expect(await readGroups()).toMatchObject([{ name: 'Product design' }])
  })

  it('keeps the name of a group updated without a rename', async () => {
    await created({ groups: [designers] })

    await handle('b2b.group.updated', {
      organizationId: 'evilcorp123',
      id: DESIGNERS_ID,
      name: '',
      color: '#ff0000',
      timestamp: '2026-10-05T09:12:44.512Z'
    })

    expect(await readGroups()).toMatchObject([{ name: 'Designers' }])
  })

  it('refuses a group event without groups', async () => {
    await expect(group('twake.space.group.linked', [])).rejects.toBeInstanceOf(
      MalformedEventError
    )
  })
})

describe('organization roles', () => {
  const readRoles = () =>
    testDb.db
      .select({
        organizationId: organizationMembers.organizationId,
        userId: organizationMembers.userId,
        role: organizationMembers.role
      })
      .from(organizationMembers)
  const roleChanged = (body: Record<string, unknown>) =>
    handle('b2b.member.role.changed', {
      organizationId: 'evilcorp123',
      username: 'jdoe',
      email: jdoe.email,
      workspaceUrl: 'jdoe.twake.app',
      role: 'admin',
      previousRole: 'member',
      actor: 'owner@evilcorp.com',
      timestamp: '2026-10-05T09:12:44.512Z',
      ...body
    })

  it("stores a user's organization role", async () => {
    await roleChanged({ uuid: JDOE_ID })

    expect(await readRoles()).toEqual([
      { organizationId: 'evilcorp123', userId: JDOE_ID, role: 'admin' }
    ])
  })

  it("changes a user's organization role", async () => {
    await roleChanged({ uuid: JDOE_ID })
    await roleChanged({
      uuid: JDOE_ID,
      role: 'owner',
      timestamp: '2026-10-05T10:00:00Z'
    })

    expect(await readRoles()).toMatchObject([{ role: 'owner' }])
  })

  it('ignores a role change older than the last one', async () => {
    await roleChanged({ uuid: JDOE_ID, timestamp: '2026-10-05T10:00:00Z' })
    await roleChanged({
      uuid: JDOE_ID,
      role: 'member',
      timestamp: '2026-10-05T09:00:00Z'
    })

    expect(await readRoles()).toMatchObject([{ role: 'admin' }])
  })

  it('finds a user sent without a uuid by their email', async () => {
    await created()

    await roleChanged({})

    expect(await readRoles()).toMatchObject([{ userId: JDOE_ID }])
  })

  it('demotes an admin in no space, sent by email only', async () => {
    await roleChanged({ uuid: JDOE_ID })

    await roleChanged({ role: 'member', timestamp: '2026-10-05T10:00:00Z' })

    expect(await readRoles()).toMatchObject([{ role: 'member' }])
  })

  it('finds a user by email in their own organization only', async () => {
    await roleChanged({ uuid: JDOE_ID, organizationId: 'other-org' })

    await roleChanged({ role: 'admin' })

    expect(await readRoles()).toEqual([
      { organizationId: 'other-org', userId: JDOE_ID, role: 'admin' }
    ])
  })

  it('removes the role of a deleted user', async () => {
    await roleChanged({ uuid: JDOE_ID })

    await handle('domain.user.deleted', {
      uuid: JDOE_ID,
      internalEmail: jdoe.email
    })

    expect(await readRoles()).toEqual([])
  })

  it('does not bring back a deleted user with an older role change', async () => {
    await handle('domain.user.deleted', {
      uuid: JDOE_ID,
      timestamp: '2026-10-05T10:00:00Z'
    })

    await roleChanged({ uuid: JDOE_ID, timestamp: '2026-10-05T09:30:00Z' })

    expect(await readRoles()).toEqual([])
  })

  it('refuses an unknown role', async () => {
    await expect(
      roleChanged({ uuid: JDOE_ID, role: 'emperor' })
    ).rejects.toBeInstanceOf(MalformedEventError)
  })
})

describe('stale events', () => {
  const at = (time: string) => `2026-10-05T${time}Z`
  const space = (routingKey: string, time: string, body = {}) =>
    handle(routingKey, {
      organizationId: 'evilcorp123',
      id: SPACE_ID,
      timestamp: at(time),
      ...body
    })

  it('ignores a member event older than the last change to that member', async () => {
    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      members: [jdoe]
    })
    await space('twake.space.member.removed', '10:00:00', { members: [jdoe] })

    await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

    expect(await readMembers()).toEqual([])
  })

  it('ignores a removal older than the last change to that member', async () => {
    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      members: [jdoe]
    })
    await space('twake.space.member.role.changed', '10:00:00', {
      members: [{ ...jdoe, role: 'admin' }]
    })

    await space('twake.space.member.removed', '09:30:00', { members: [jdoe] })

    expect(await readMembers()).toMatchObject([{ role: 'admin' }])
  })

  it('ignores a rename older than the last one', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await space('twake.space.updated', '10:00:00', { name: 'Design' })

    await space('twake.space.updated', '09:30:00', { name: 'Sprint' })

    expect(await readSpace()).toMatchObject([{ name: 'Design' }])
  })

  it('does not bring back a deleted space or its members', async () => {
    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      members: [jdoe],
      groups: [designers]
    })
    await space('twake.space.deleted', '10:00:00')

    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      members: [jdoe]
    })
    await space('twake.space.member.added', '09:30:00', { members: [jdoe] })
    await space('twake.space.group.linked', '09:30:00', { groups: [designers] })

    expect(await readSpace()).toEqual([])
    expect(await readMembers()).toEqual([])
    expect(await readGroups()).toEqual([])
  })

  it('waits for the creation of a space renamed before it arrives', async () => {
    await expect(
      space('twake.space.updated', '10:00:00', { name: 'Design' })
    ).rejects.toThrow(NotYetKnownError)

    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      members: [jdoe]
    })
    await space('twake.space.updated', '10:00:00', { name: 'Design' })

    expect(await readSpace()).toMatchObject([{ name: 'Design' }])
    expect(await readMembers()).toHaveLength(1)
  })

  it('drops the rename of a deleted space', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await space('twake.space.deleted', '10:00:00')

    await space('twake.space.updated', '09:30:00', { name: 'Design' })

    expect(await readSpace()).toEqual([])
  })

  it('keeps out a member removed before their addition arrives', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await space('twake.space.member.removed', '10:00:00', { members: [jdoe] })

    await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

    expect(await readMembers()).toEqual([])
  })

  it.each([
    ['uuid', { uuid: JDOE_ID }],
    ['email', { internalEmail: jdoe.email }]
  ])(
    'keeps a user deleted by %s out of a space they were added to before',
    async (_by, user) => {
      await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
      await handle('domain.user.deleted', {
        ...user,
        timestamp: at('10:00:00')
      })

      await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

      expect(await readMembers()).toEqual([])
    }
  )

  it.each([
    ['ISO 8601', at('10:00:00')],
    ['generalized time', at('10:00:00').replace(/[-:T]|\.\d+/g, '')]
  ])(
    'orders a deletion without a timestamp by its deletedAt in %s',
    async (_format, deletedAt) => {
      await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
      await handle('domain.user.deleted', {
        uuid: JDOE_ID,
        internalEmail: jdoe.email,
        deletedAt
      })

      await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

      expect(await readMembers()).toEqual([])
    }
  )

  it('deletes a user whose deletedAt is unreadable, as an event without a time', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

    await handle('domain.user.deleted', { uuid: JDOE_ID, deletedAt: 'soon' })
    expect(await readMembers()).toEqual([])

    await space('twake.space.member.added', '09:45:00', { members: [jdoe] })
    expect(await readMembers()).toHaveLength(1)
  })

  it('adds a user deleted by email when the addition is newer', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await handle('domain.user.deleted', {
      internalEmail: jdoe.email,
      timestamp: at('10:00:00')
    })

    await space('twake.space.member.added', '11:00:00', { members: [jdoe] })

    expect(await readMembers()).toHaveLength(1)
  })

  it('names a group renamed before it is linked by its newest name', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await handle('b2b.group.updated', {
      organizationId: 'evilcorp123',
      id: DESIGNERS_ID,
      name: 'Product design',
      timestamp: at('10:00:00')
    })

    await space('twake.space.group.linked', '09:30:00', { groups: [designers] })

    expect(await readGroups()).toMatchObject([{ name: 'Product design' }])
  })

  it('does not add a member to a space deleted after the event', async () => {
    await space('twake.space.created', '09:00:00', { name: 'Design Sprint' })
    await space('twake.space.deleted', '10:00:00')

    await space('twake.space.member.added', '09:30:00', { members: [jdoe] })

    expect(await readMembers()).toEqual([])
  })

  it('ignores a group rename older than the last one', async () => {
    await space('twake.space.created', '09:00:00', {
      name: 'Design Sprint',
      groups: [designers]
    })
    const renamed = (time: string, name: string) =>
      handle('b2b.group.updated', {
        organizationId: 'evilcorp123',
        id: DESIGNERS_ID,
        name,
        timestamp: at(time)
      })
    await renamed('10:00:00', 'Product design')

    await renamed('09:30:00', 'UX')

    expect(await readGroups()).toMatchObject([{ name: 'Product design' }])
  })
})
