import { and, eq, lte, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { CloudEvent } from '../../events/envelope.ts'
import { fresh } from '../../events/freshness.ts'
import {
  parseOrDrop,
  RejectedEventError,
  type Handler
} from '../../events/router.ts'
import type { Tx } from '../../infra/db.ts'
import { attachToSpace } from '../feed/activity.ts'
import { tellSpaceMembers } from '../live/notify.ts'
import { deletedAfter, resourceKey } from './events.ts'
import {
  spaceDriveReplies,
  spaceResourceKind,
  spaceResources,
  spaces
} from './schema.ts'

type SpaceResourceKind = (typeof spaceResourceKind.enumValues)[number]

export const spaceApp = z.enum(['chat', 'tasks', 'drive', 'mail', 'calendar'])
export type SpaceApp = z.infer<typeof spaceApp>

export const APP_KINDS = {
  drive: 'drive',
  mail: 'mailbox',
  calendar: 'calendar',
  chat: 'matrix_space',
  tasks: 'project'
} as const satisfies Record<SpaceApp, SpaceResourceKind>

function onProvisioned(kind: SpaceResourceKind): Handler<CloudEvent> {
  const provisioned = z.looseObject({
    twakeorg: z.string().min(1),
    data: z.looseObject({
      space_id: z.uuid(),
      resource: z.looseObject({ kind: z.literal(kind), id: z.string().min(1) })
    })
  })
  return async (event, tx, log) => {
    const {
      twakeorg,
      data: { space_id, resource }
    } = parseOrDrop(provisioned, event, event.type)
    const at = event.time === undefined ? undefined : new Date(event.time)
    if (await deletedAfter(tx, space_id, at)) return
    const [space] = await tx
      .select({ organizationId: spaces.organizationId })
      .from(spaces)
      .where(eq(spaces.spaceId, space_id))
    // An app provisions on the space's created event, which reached our queue
    // before this one, so the space was deleted meanwhile; the app's next sync
    // removes the resource.
    if (!space) {
      log.warn({ spaceId: space_id, kind }, 'resource of an unknown space')
      return
    }
    if (space.organizationId !== twakeorg) {
      throw new RejectedEventError(
        `space ${space_id} belongs to another organization`
      )
    }
    if (!(await fresh(tx, at, [resourceKey(space_id, kind)])).size) return
    await recordResource(tx, space_id, twakeorg, kind, resource.id)
  }
}

async function recordResource(
  tx: Tx,
  spaceId: string,
  organizationId: string,
  kind: SpaceResourceKind,
  resourceId: string
) {
  await tx
    .insert(spaceResources)
    .values({ spaceId, kind, organizationId, resourceId })
    .onConflictDoUpdate({
      target: [spaceResources.spaceId, spaceResources.kind],
      set: { resourceId, provisionedAt: sql`now()` }
    })
  await attachToSpace(tx, spaceId, organizationId, { kind, id: resourceId })
  await tellSpaceMembers(tx, spaceId)
}

// Drive provisions from our drive.org_drive.ensure commands and replies below.
export const resourceActivityRoutes: ReadonlyMap<
  string,
  Handler<CloudEvent>
> = new Map(
  Object.entries(APP_KINDS)
    .filter(([app]) => app !== 'drive')
    .map(([app, kind]) => [
      `com.twake.${app}.space.provisioned.v1`,
      onProvisioned(kind)
    ])
)

const driveReply = z.looseObject({
  twakeorg: z.string().min(1),
  data: z.looseObject({
    reference: z.looseObject({ source: z.string(), id: z.string() }),
    revision: z.number().int().positive()
  })
})

const readyDrive = driveReply.extend({
  data: driveReply.shape.data.extend({
    drive: z.looseObject({ id: z.string().min(1) }),
    // Only logged, so a list we cannot read must not cost the drive id.
    skipped: z.array(z.record(z.string(), z.unknown())).catch([])
  })
})

// Returns the space of a reply that is still the newest for it, under the
// lock of its revision row, so the replies of one space take turns.
async function applies(
  tx: Tx,
  log: Logger,
  { twakeorg, data: { reference, revision } }: z.output<typeof driveReply>
): Promise<string | undefined> {
  if (reference.source !== 'twake-space') return undefined
  const spaceId = parseOrDrop(z.uuid(), reference.id, 'reference.id')
  const [space] = await tx
    .select({ organizationId: spaces.organizationId })
    .from(spaces)
    .where(eq(spaces.spaceId, spaceId))
  // We send commands only for the spaces we hold, so it was deleted meanwhile.
  if (!space) {
    log.warn({ spaceId }, 'drive reply for an unknown space')
    return undefined
  }
  if (space.organizationId !== twakeorg) {
    throw new RejectedEventError(
      `space ${spaceId} belongs to another organization`
    )
  }
  const [newest] = await tx
    .insert(spaceDriveReplies)
    .values({ spaceId, revision })
    .onConflictDoUpdate({
      target: spaceDriveReplies.spaceId,
      set: { revision },
      setWhere: lte(spaceDriveReplies.revision, revision)
    })
    .returning({ spaceId: spaceDriveReplies.spaceId })
  return newest?.spaceId
}

const onDriveReady: Handler<CloudEvent> = async (event, tx, log) => {
  const reply = parseOrDrop(readyDrive, event, event.type)
  const spaceId = await applies(tx, log, reply)
  if (!spaceId) return
  const {
    twakeorg: organizationId,
    data: { drive, skipped }
  } = reply
  for (const entry of skipped) {
    log.warn({ spaceId, skipped: entry }, 'drive member skipped')
  }
  await recordResource(tx, spaceId, organizationId, 'drive', drive.id)
}

const onDriveRemoved: Handler<CloudEvent> = async (event, tx, log) => {
  const reply = parseOrDrop(driveReply, event, event.type)
  const spaceId = await applies(tx, log, reply)
  if (!spaceId) return
  await tx
    .delete(spaceResources)
    .where(
      and(eq(spaceResources.spaceId, spaceId), eq(spaceResources.kind, 'drive'))
    )
  await tellSpaceMembers(tx, spaceId)
}

export const driveReplyRoutes: ReadonlyMap<
  string,
  Handler<CloudEvent>
> = new Map([
  ['com.twake.drive.org_drive.ready.v1', onDriveReady],
  ['com.twake.drive.org_drive.removed.v1', onDriveRemoved]
])
