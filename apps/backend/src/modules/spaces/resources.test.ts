import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudEvent } from '../../events/envelope.ts'
import { lastChanges } from '../../events/schema.ts'
import { MalformedEventError, RejectedEventError } from '../../events/router.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import { activityRoute } from '../feed/activity.ts'
import { activityEvents, feedCards } from '../feed/schema.ts'
import { driveReplyRoutes, resourceActivityRoutes } from './resources.ts'
import { spaceDriveReplies, spaceResources, spaces } from './schema.ts'

const SPACE_ID = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())
beforeEach(async () => {
  await testDb.db.delete(activityEvents)
  await testDb.db.delete(spaceResources)
  await testDb.db.delete(spaceDriveReplies)
  await testDb.db.delete(lastChanges)
  await testDb.db.delete(spaces)
  await testDb.db
    .insert(spaces)
    .values({ spaceId: SPACE_ID, organizationId: 'linagora', name: 'Design' })
})

function provisioned(
  app: string,
  resource: Record<string, unknown>,
  overrides: Partial<CloudEvent> = {}
) {
  const type = `com.twake.${app}.space.provisioned.v1`
  const handler = resourceActivityRoutes.get(type)
  if (!handler) throw new Error(`no handler for ${type}`)
  const event: CloudEvent = {
    specversion: '1.0',
    id: '01J9Z7A2B3C4D5E6F7G8H9J0KM',
    source: `twake://${app}`,
    type,
    twakeorg: 'linagora',
    data: { space_id: SPACE_ID, resource },
    ...overrides
  }
  return testDb.db.transaction(tx =>
    handler(event, tx, pino({ level: 'silent' }))
  )
}

const readResources = () =>
  testDb.db
    .select({
      spaceId: spaceResources.spaceId,
      kind: spaceResources.kind,
      organizationId: spaceResources.organizationId,
      resourceId: spaceResources.resourceId
    })
    .from(spaceResources)

describe('provisioned events', () => {
  it('does not bring back a resource of a space deleted after the event', async () => {
    await testDb.db.delete(spaces)
    await testDb.db.insert(lastChanges).values({
      object: `space:${SPACE_ID}`,
      at: new Date('2026-10-05T10:00:00Z')
    })

    await provisioned(
      'calendar',
      { kind: 'calendar', id: 'a1f0c3e2d4b5' },
      { time: '2026-10-05T09:30:00Z' }
    )

    expect(await readResources()).toEqual([])
  })

  it('drops a resource of a space deleted before the event', async () => {
    await testDb.db.delete(spaces)
    await testDb.db.insert(lastChanges).values({
      object: `space:${SPACE_ID}`,
      at: new Date('2026-10-05T10:00:00Z')
    })

    await provisioned(
      'calendar',
      { kind: 'calendar', id: 'a1f0c3e2d4b5' },
      { time: '2026-10-05T10:00:01Z' }
    )

    expect(await readResources()).toEqual([])
  })

  it('drops a resource of a space it never had', async () => {
    await testDb.db.delete(spaces)

    await provisioned('calendar', { kind: 'calendar', id: 'a1f0c3e2d4b5' })

    expect(await readResources()).toEqual([])
  })

  it('rejects a resource sent for a space of another organization', async () => {
    await expect(
      provisioned(
        'calendar',
        { kind: 'calendar', id: 'a1f0c3e2d4b5' },
        { twakeorg: 'globex' }
      )
    ).rejects.toBeInstanceOf(RejectedEventError)
    expect(await readResources()).toEqual([])
  })

  it('stores the resource id of a space', async () => {
    await provisioned('calendar', { kind: 'calendar', id: 'a1f0c3e2d4b5' })

    expect(await readResources()).toEqual([
      {
        spaceId: SPACE_ID,
        kind: 'calendar',
        organizationId: 'linagora',
        resourceId: 'a1f0c3e2d4b5'
      }
    ])
  })

  it("stores the space's Tasks project", async () => {
    await provisioned('tasks', { kind: 'project', id: 'project-7' })

    expect(await readResources()).toMatchObject([
      { kind: 'project', resourceId: 'project-7' }
    ])
  })

  it('keeps one resource per kind when provisioned again', async () => {
    await provisioned('mail', { kind: 'mailbox', id: 'team-1' })
    await provisioned('mail', { kind: 'mailbox', id: 'team-2' })

    expect(await readResources()).toMatchObject([{ resourceId: 'team-2' }])
  })

  it('refuses an unknown kind', async () => {
    await expect(
      provisioned('calendar', { kind: 'matrix_room', id: 'x' })
    ).rejects.toBeInstanceOf(MalformedEventError)
  })

  it("refuses a kind that is not the app's own", async () => {
    await expect(
      provisioned('calendar', { kind: 'mailbox', id: 'team-1' })
    ).rejects.toBeInstanceOf(MalformedEventError)
  })

  it('refuses a provisioned event without an organization', async () => {
    await expect(
      provisioned(
        'calendar',
        { kind: 'calendar', id: 'a1' },
        { twakeorg: undefined }
      )
    ).rejects.toBeInstanceOf(MalformedEventError)
  })

  it('ignores a provisioned event older than the last one', async () => {
    await provisioned(
      'calendar',
      { kind: 'calendar', id: 'new' },
      { time: '2026-10-05T10:00:00Z' }
    )

    await provisioned(
      'calendar',
      { kind: 'calendar', id: 'old' },
      { time: '2026-10-05T09:00:00Z' }
    )

    expect(await readResources()).toMatchObject([{ resourceId: 'new' }])
  })

  it("leaves the space's drive to the drive replies", () => {
    expect(
      resourceActivityRoutes.get('com.twake.drive.space.provisioned.v1')
    ).toBeUndefined()
  })
})

describe('drive replies', () => {
  function reply(
    name: 'ready' | 'removed',
    data: Record<string, unknown>,
    overrides: Partial<CloudEvent> = {},
    log = pino({ level: 'silent' })
  ) {
    const type = `com.twake.drive.org_drive.${name}.v1`
    const handler = driveReplyRoutes.get(type)
    if (!handler) throw new Error(`no handler for ${type}`)
    const event: CloudEvent = {
      specversion: '1.0',
      id: randomUUID(),
      source: 'twake://drive',
      type,
      twakeorg: 'linagora',
      data: { reference: { source: 'twake-space', id: SPACE_ID }, ...data },
      ...overrides
    }
    return testDb.db.transaction(tx => handler(event, tx, log))
  }

  const ready = (
    revision: number,
    driveId: string,
    overrides: Partial<CloudEvent> = {}
  ) => reply('ready', { revision, drive: { id: driveId } }, overrides)

  it('records the drive of the space', async () => {
    await ready(1, 'a1f0c3e2d4b5')

    expect(await readResources()).toEqual([
      {
        spaceId: SPACE_ID,
        kind: 'drive',
        organizationId: 'linagora',
        resourceId: 'a1f0c3e2d4b5'
      }
    ])
  })

  it('takes the drive of a newer revision', async () => {
    await ready(1, 'old')
    await ready(2, 'new')

    expect(await readResources()).toMatchObject([{ resourceId: 'new' }])
  })

  it('ignores a reply older than the one recorded', async () => {
    await ready(3, 'new')
    await ready(2, 'old')

    expect(await readResources()).toMatchObject([{ resourceId: 'new' }])
  })

  it('takes the same reply twice', async () => {
    await ready(1, 'a1f0c3e2d4b5')
    await ready(1, 'a1f0c3e2d4b5')

    expect(await readResources()).toMatchObject([
      { resourceId: 'a1f0c3e2d4b5' }
    ])
  })

  it('forgets the drive once removed', async () => {
    await ready(1, 'a1f0c3e2d4b5')

    await reply('removed', { revision: 2 })

    expect(await readResources()).toEqual([])
  })

  it('does not bring back a removed drive on a late reply', async () => {
    await reply('removed', { revision: 2 })

    await ready(1, 'a1f0c3e2d4b5')

    expect(await readResources()).toEqual([])
  })

  it('ignores the drives of other apps', async () => {
    await reply('ready', {
      reference: { source: 'twake-chat', id: SPACE_ID },
      revision: 1,
      drive: { id: 'a1f0c3e2d4b5' }
    })

    expect(await readResources()).toEqual([])
  })

  it('drops the drive of a space it does not have', async () => {
    await testDb.db.delete(spaces)

    await ready(1, 'a1f0c3e2d4b5')

    expect(await readResources()).toEqual([])
  })

  it('rejects a drive sent for a space of another organization', async () => {
    await expect(
      ready(1, 'a1f0c3e2d4b5', { twakeorg: 'globex' })
    ).rejects.toBeInstanceOf(RejectedEventError)
    expect(await readResources()).toEqual([])
  })

  it('refuses a reply without a revision', async () => {
    await expect(
      reply('ready', { drive: { id: 'a1f0c3e2d4b5' } })
    ).rejects.toBeInstanceOf(MalformedEventError)
  })

  it('logs the members the drive skipped', async () => {
    const lines: Record<string, unknown>[] = []
    const log = pino(
      { level: 'warn' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        }
      }
    )

    await reply(
      'ready',
      {
        revision: 1,
        drive: { id: 'a1f0c3e2d4b5' },
        skipped: [
          {
            email: 'carol@example.com',
            reason: 'not in the organization directory'
          }
        ]
      },
      {},
      log
    )

    expect(lines).toMatchObject([
      {
        spaceId: SPACE_ID,
        skipped: {
          email: 'carol@example.com',
          reason: 'not in the organization directory'
        }
      }
    ])
  })

  describe('after activity on the drive', () => {
    function activity(twakeorg = 'linagora') {
      const type = 'com.twake.drive.file.created.v1'
      const handler = activityRoute.get(type)
      if (!handler) throw new Error(`no handler for ${type}`)
      const event: CloudEvent = {
        specversion: '1.0',
        id: '01J9Z6K4X8M2Q7R5T3V1W0Y9AB',
        source: 'twake://drive',
        type,
        time: '2026-10-05T09:14:22Z',
        twakeorg,
        data: {
          object: {
            type: 'file',
            id: 'f1',
            container: { kind: 'drive', id: 'drive-1' },
            title: 'Roadmap.odt'
          }
        }
      }
      return testDb.db.transaction(tx =>
        handler(event, tx, pino({ level: 'silent' }))
      )
    }

    const cards = () =>
      testDb.db
        .select({ spaceId: feedCards.spaceId, objectId: feedCards.objectId })
        .from(feedCards)

    it('brings the earlier activity into the space', async () => {
      await activity()

      await ready(1, 'drive-1')

      expect(
        await testDb.db
          .select({ spaceId: activityEvents.spaceId })
          .from(activityEvents)
      ).toEqual([{ spaceId: SPACE_ID }])
      expect(await cards()).toEqual([{ spaceId: SPACE_ID, objectId: 'f1' }])
    })

    it("leaves another organization's activity out", async () => {
      await activity('globex')

      await ready(1, 'drive-1')

      expect(await cards()).toEqual([])
    })

    it('leaves out activity older than the wait for a late event', async () => {
      await activity()
      await testDb.db
        .update(activityEvents)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })

      await ready(1, 'drive-1')

      expect(await cards()).toEqual([])
    })
  })
})
