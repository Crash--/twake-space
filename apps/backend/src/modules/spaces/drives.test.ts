import { setTimeout as delay } from 'node:timers/promises'
import { asc, eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformEvent } from '../../events/envelope.ts'
import { lastChanges } from '../../events/schema.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { publishDriveCommands } from './drives.ts'
import { spacePlatformRoutes } from './events.ts'
import { reconcileOrganization } from './reconcile.ts'
import { driveCommands, spaceGroups, spaceMembers, spaces } from './schema.ts'

const SPACE_ID = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'
const OTHER_ID = '9d1c7a52-0b3e-4f6a-8c2d-5e4f3a2b1c0d'
const JDOE_ID = '8f14e45f-ceea-467a-9575-1d1c2b0c4b2e'
const ASMITH_ID = 'c9f0f895-fb98-4b91-a1a4-7f3e2d1c0b5a'
const DESIGNERS_ID = 'c2a8e1f0-7b3d-4e9a-8f61-2d5b9c0e4a17'
const ORG = 'evilcorp123'

const jdoe = {
  uuid: JDOE_ID,
  username: 'jdoe',
  email: 'jdoe@evilcorp.com',
  role: 'editor'
}
const asmith = {
  uuid: ASMITH_ID,
  username: 'asmith',
  email: 'asmith@evilcorp.com',
  role: 'viewer'
}
const designers = { id: DESIGNERS_ID, name: 'Designers', role: 'viewer' }

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
const log = pino({ level: 'silent' })

beforeEach(async () => {
  for (const table of [
    spaceMembers,
    spaceGroups,
    spaces,
    lastChanges,
    driveCommands
  ]) {
    await testDb.db.delete(table)
  }
})

function handle(routingKey: string, body: Record<string, unknown>) {
  const handler = spacePlatformRoutes.get(routingKey)
  if (!handler) throw new Error(`no handler for ${routingKey}`)
  const event: PlatformEvent = { routingKey, messageId: 'msg-1', body }
  return testDb.db.transaction(tx => handler(event, tx, log))
}

const created = (id = SPACE_ID) =>
  handle('twake.space.created', {
    organizationId: ORG,
    id,
    name: 'Design Sprint',
    members: [jdoe],
    groups: [designers]
  })

async function pending(id = SPACE_ID) {
  const [row] = await testDb.db
    .select({ command: driveCommands.command })
    .from(driveCommands)
    .where(eq(driveCommands.spaceId, id))
  return row?.command
}

describe('drive commands', () => {
  it("sends a created space's full state", async () => {
    await created()

    expect(await pending()).toEqual({
      organizationId: ORG,
      reference: { source: 'twake-space', id: SPACE_ID },
      revision: expect.any(Number) as number,
      state: 'created',
      name: 'Design Sprint',
      members: [{ email: 'jdoe@evilcorp.com', role: 'write' }],
      groups: [{ id: DESIGNERS_ID, role: 'read' }],
      activity: true
    })
  })

  it('sends a higher revision with each change', async () => {
    await created()
    const first = (await pending())?.revision as number

    await handle('twake.space.member.added', {
      organizationId: ORG,
      id: SPACE_ID,
      members: [asmith]
    })
    await handle('twake.space.updated', {
      organizationId: ORG,
      id: SPACE_ID,
      name: 'Launch'
    })

    const command = await pending()
    expect(command?.revision).toBeGreaterThan(first)
    expect(command).toMatchObject({
      name: 'Launch',
      members: expect.arrayContaining([
        { email: 'jdoe@evilcorp.com', role: 'write' },
        { email: 'asmith@evilcorp.com', role: 'read' }
      ]) as unknown
    })
  })

  it('leaves out removed members and unlinked groups', async () => {
    await created()

    await handle('twake.space.member.removed', {
      organizationId: ORG,
      id: SPACE_ID,
      members: [{ uuid: JDOE_ID }]
    })
    await handle('twake.space.group.unlinked', {
      organizationId: ORG,
      id: SPACE_ID,
      groups: [{ id: DESIGNERS_ID }]
    })

    expect(await pending()).toMatchObject({ members: [], groups: [] })
  })

  it('removes the drive of a deleted space and keeps counting', async () => {
    await created()
    const before = (await pending())?.revision as number

    await handle('twake.space.deleted', { organizationId: ORG, id: SPACE_ID })

    expect(await pending()).toEqual({
      organizationId: ORG,
      reference: { source: 'twake-space', id: SPACE_ID },
      revision: expect.any(Number) as number,
      state: 'removed',
      activity: true
    })
    expect((await pending())?.revision).toBeGreaterThan(before)
  })

  it('removes the drive of every space of a deleted organization', async () => {
    await created()
    await created(OTHER_ID)

    await handle('domain.organization.deleted', { organizationId: ORG })

    expect(await pending()).toMatchObject({ state: 'removed' })
    expect(await pending(OTHER_ID)).toMatchObject({ state: 'removed' })
  })

  it('never creates again the drive of a space whose organization is deleted', async () => {
    await created()
    await handle('domain.organization.deleted', { organizationId: ORG })
    await testDb.db.update(driveCommands).set({ command: null })

    await handle('twake.space.updated', {
      organizationId: ORG,
      id: SPACE_ID,
      name: 'Launch'
    })
    await handle('b2b.member.disabled', {
      organizationId: ORG,
      username: 'jdoe',
      email: 'jdoe@evilcorp.com'
    })
    await handle('domain.user.deleted', { uuid: JDOE_ID })

    expect(await pending()).toBeNull()
  })

  it('stores one command per space for a whole transaction', async () => {
    await testDb.db
      .insert(driveCommands)
      .values({ spaceId: SPACE_ID, organizationId: ORG, revision: 2 ** 50 })

    await created()

    expect((await pending())?.revision).toBe(2 ** 50 + 1)
  })

  it('keeps counting up after the revisions were reset', async () => {
    await testDb.db
      .insert(driveCommands)
      .values({ spaceId: SPACE_ID, organizationId: ORG, revision: 5 })
    const before = Date.now()

    await created()

    expect((await pending())?.revision).toBeGreaterThanOrEqual(before)
  })

  it("locks the drive row only once the transaction's changes are done", async () => {
    await created()
    const handler = spacePlatformRoutes.get('twake.space.updated')
    let lockedMidway: unknown

    await testDb.db.transaction(async tx => {
      await handler?.(
        {
          routingKey: 'twake.space.updated',
          messageId: 'msg-2',
          body: { organizationId: ORG, id: SPACE_ID, name: 'Launch' }
        },
        tx,
        log
      )
      lockedMidway = await testDb.sql`
        select 1 from drive_commands where space_id = ${SPACE_ID}
        for update nowait`.then(
        () => false,
        (error: unknown) => error
      )
    })

    expect(lockedMidway).toBe(false)
    expect(await pending()).toMatchObject({ name: 'Launch' })
  })

  it('sends again the spaces of a disabled member and of a deleted one', async () => {
    await created()
    await testDb.db.update(driveCommands).set({ command: null })

    await handle('b2b.member.disabled', {
      organizationId: ORG,
      username: 'jdoe',
      email: 'jdoe@evilcorp.com'
    })
    expect(await pending()).toMatchObject({
      members: [{ email: 'jdoe@evilcorp.com', role: 'write' }]
    })

    await handle('domain.user.deleted', { uuid: JDOE_ID })
    expect(await pending()).toMatchObject({ members: [] })
  })

  it('sends nothing for a space not created yet', async () => {
    await handle('twake.space.member.added', {
      organizationId: ORG,
      id: SPACE_ID,
      members: [jdoe]
    })

    expect(await testDb.db.select().from(driveCommands)).toEqual([])
  })

  it('sends the state of every space the reconciliation lists', async () => {
    await created()
    await testDb.db.update(driveCommands).set({ command: null })

    await reconcileOrganization(
      testDb.db,
      {
        list: () => Promise.resolve([{ id: SPACE_ID, name: 'Design Sprint' }]),
        members: () => Promise.resolve([{ ...jdoe, displayName: null }]),
        groups: () => Promise.resolve([designers]),
        exists: () => Promise.resolve(true)
      } as Parameters<typeof reconcileOrganization>[1],
      log,
      ORG
    )

    expect(await pending()).toMatchObject({ state: 'created' })
  })
})

describe('publishDriveCommands', () => {
  it('publishes each pending command once', async () => {
    await created()
    await created(OTHER_ID)
    const published: unknown[] = []

    await publishDriveCommands(testDb.db, command => {
      published.push(command)
      return Promise.resolve()
    })
    await publishDriveCommands(testDb.db, command => {
      published.push(command)
      return Promise.resolve()
    })

    expect(published).toHaveLength(2)
    expect(
      await testDb.db
        .select({ command: driveCommands.command })
        .from(driveCommands)
        .orderBy(asc(driveCommands.spaceId))
    ).toEqual([{ command: null }, { command: null }])
  })

  it('keeps a newer revision stored while publishing', async () => {
    await created()
    let renamed: Promise<void> | undefined

    await publishDriveCommands(testDb.db, () => {
      renamed ??= handle('twake.space.updated', {
        organizationId: ORG,
        id: SPACE_ID,
        name: 'Launch'
      })
      return delay(50)
    })
    await renamed

    expect(await pending()).toMatchObject({ name: 'Launch' })
  })

  it('lets replicas sweeping together publish each command once', async () => {
    await created()
    await created(OTHER_ID)
    const published: unknown[] = []
    const publish = (command: Record<string, unknown>) => {
      published.push(command)
      return delay(50)
    }

    await Promise.all([
      publishDriveCommands(testDb.db, publish),
      publishDriveCommands(testDb.db, publish)
    ])

    expect(published).toHaveLength(2)
  })

  it('keeps the command when the broker refuses it', async () => {
    await created()

    await expect(
      publishDriveCommands(testDb.db, () =>
        Promise.reject(new Error('NOT_FOUND - no exchange'))
      )
    ).rejects.toThrow('NOT_FOUND')

    expect(await pending()).toMatchObject({ state: 'created' })
  })
})
