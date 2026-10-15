import { eq, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { PlatformEvent } from '../../events/envelope.ts'
import { fresh } from '../../events/freshness.ts'
import {
  NotYetKnownError,
  parseOrDrop,
  type Handler,
  type Routes
} from '../../events/router.ts'
import type { Tx } from '../../infra/db.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import type { TenantHomeservers } from './control-plane.ts'
import { linkHomeserver } from './homeservers.ts'
import { organizations } from './schema.ts'

type Lookup = Routes['platform']

const aboutOrganization = z.looseObject({ organizationId: z.string().min(1) })

const DEPLOYMENTS = new Set([
  'chat.deployment.completed',
  'chat.deployment.updated'
])

interface MeetingDeps {
  directory: Pick<Directory, 'organization'>
  // A single installation's homeserver, which serves every organization.
  homeserverId?: string | undefined
  // In SaaS, where each tenant's homeserver comes from the chat control plane.
  tenants?: TenantHomeservers | null | undefined
}

// A failing control plane leaves the organization's homeserver as it was: the
// event that met the organization goes on, a chat deployment is retried.
async function refreshHomeserver(
  tx: Tx,
  deps: MeetingDeps,
  log: Logger,
  organizationId: string,
  { retry }: { retry: boolean }
) {
  const tenants = deps.tenants
  if (!tenants) return
  try {
    await tx.transaction(async savepoint => {
      const homeserver = await tenants.homeserverOf(organizationId)
      if (homeserver) {
        await linkHomeserver(savepoint, organizationId, homeserver)
      }
    })
  } catch (error) {
    log.warn(
      { err: error, organizationId },
      'could not refresh the homeserver from the chat control plane'
    )
    if (retry) {
      throw new NotYetKnownError(
        `homeserver of ${organizationId} from the chat control plane`
      )
    }
  }
}

// The directory is read once: after that, events are newer than what the admin
// panel may have written to it yet.
async function meet(
  tx: Tx,
  deps: MeetingDeps,
  log: Logger,
  organizationId: string
) {
  const [known] = await tx
    .select({ organizationId: organizations.organizationId })
    .from(organizations)
    .where(eq(organizations.organizationId, organizationId))
  if (known) return
  const found = await deps.directory.organization(organizationId)
  if (!found) {
    log.warn({ organizationId }, 'organization not in the directory')
    return
  }
  await tx
    .insert(organizations)
    .values({
      organizationId,
      domain: found.domain,
      // A single installation's homeserver serves chat to every organization.
      chatAvailable: found.chat || deps.homeserverId !== undefined,
      mailAvailable: found.mail,
      homeserverId: deps.homeserverId
    })
    .onConflictDoNothing()
  await refreshHomeserver(tx, deps, log, organizationId, { retry: false })
}

export function meetingOrganizations(
  deps: MeetingDeps,
  routes: Lookup
): Lookup {
  return {
    get(key) {
      const handler = routes.get(key)
      if (!handler) return undefined
      return async (event, tx, log) => {
        const about = aboutOrganization.safeParse(event.body)
        if (about.success) {
          await meet(tx, deps, log, about.data.organizationId)
        }
        await handler(event, tx, log)
        if (about.success && DEPLOYMENTS.has(key)) {
          await refreshHomeserver(tx, deps, log, about.data.organizationId, {
            retry: true
          })
        }
      }
    }
  }
}

const chatKey = (organizationId: string) =>
  `organization:${organizationId}:chat`

async function setChat(
  tx: Tx,
  organizationId: string,
  at: Date,
  chatAvailable: boolean
) {
  if (!(await fresh(tx, at, [chatKey(organizationId)])).size) return
  await tx
    .update(organizations)
    .set({ chatAvailable, updatedAt: sql`now()` })
    .where(eq(organizations.organizationId, organizationId))
}

const deploymentCompleted = z.looseObject({
  organizationId: z.string().min(1),
  deployment: z.looseObject({
    status: z.string().optional(),
    completedAt: z.iso.datetime({ offset: true }).transform(t => new Date(t))
  })
})

const onDeploymentCompleted: Handler<PlatformEvent> = async (
  event,
  tx,
  log
) => {
  const { organizationId, deployment } = parseOrDrop(
    deploymentCompleted,
    event.body,
    event.routingKey
  )
  // The control plane publishes only successes and sends no status yet.
  if (deployment.status !== undefined && deployment.status !== 'succeeded') {
    log.info({ organizationId, status: deployment.status }, 'chat not deployed')
    return
  }
  await setChat(tx, organizationId, deployment.completedAt, true)
}

// Only the homeserver is refreshed: setting chat here would turn it back on
// for a tenant being deprovisioned.
const onDeploymentUpdated: Handler<PlatformEvent> = event => {
  parseOrDrop(aboutOrganization, event.body, event.routingKey)
  return Promise.resolve()
}

const deprovisioned = z.looseObject({
  organizationId: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }).transform(t => new Date(t))
})

const onDeprovisioned: Handler<PlatformEvent> = async (event, tx) => {
  const { organizationId, timestamp } = parseOrDrop(
    deprovisioned,
    event.body,
    event.routingKey
  )
  await setChat(tx, organizationId, timestamp, false)
}

const dnsValidated = z.looseObject({
  organizationId: z.string().min(1),
  mailDnsConfigurationValidated: z.boolean()
})

const onDnsValidated: Handler<PlatformEvent> = async (event, tx) => {
  const { organizationId, mailDnsConfigurationValidated } = parseOrDrop(
    dnsValidated,
    event.body,
    event.routingKey
  )
  await tx
    .update(organizations)
    .set({
      mailAvailable: mailDnsConfigurationValidated,
      updatedAt: sql`now()`
    })
    .where(eq(organizations.organizationId, organizationId))
}

export const organizationPlatformRoutes: ReadonlyMap<
  string,
  Handler<PlatformEvent>
> = new Map([
  ['chat.deployment.completed', onDeploymentCompleted],
  ['chat.deployment.updated', onDeploymentUpdated],
  ['chat.deprovision', onDeprovisioned],
  ['dns.validated', onDnsValidated]
])
