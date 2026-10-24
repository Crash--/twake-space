import { setTimeout as delay } from 'node:timers/promises'
import * as Sentry from '@sentry/node'
import amqplib from 'amqplib'
import { pino } from 'pino'
import { loadConfig } from './config.ts'
import { postgresDeduplicator } from './events/dedupe.ts'
import { scheduleActivity } from './events/outbox.ts'
import { parkIn, scheduleParkedRetries } from './events/parking.ts'
import { createMessageHandler, type Routes } from './events/router.ts'
import {
  consumerAlive,
  consumerStats,
  deadLetterQueue,
  startConsumers,
  sweepPublisher
} from './infra/amqp.ts'
import { createDb, migrateDb } from './infra/db.ts'
import { createServer } from './infra/http.ts'
import { handleSignals } from './infra/lifecycle.ts'
import {
  createLdapRestClient,
  ldapRestDirectory,
  ldapRestSpaces
} from './infra/ldap-rest.ts'
import { scheduleRevocationSweep, setUpAuth } from './modules/auth/index.ts'
import { activityRoute } from './modules/feed/activity.ts'
import { registerMetrics } from './modules/feed/metrics.ts'
import { schedulePurge } from './modules/feed/retention.ts'
import { registerFeedRoutes } from './modules/feed/routes.ts'
import { registerLinkRoutes } from './modules/links/routes.ts'
import { listenForLive } from './modules/live/notify.ts'
import { registerLiveRoutes } from './modules/live/routes.ts'
import { createStreams } from './modules/live/streams.ts'
import {
  registerMeetingRoutes,
  type Publish
} from './modules/meetings/routes.ts'
import { registerNotificationRoutes } from './modules/notifications/routes.ts'
import {
  meetingOrganizations,
  organizationPlatformRoutes
} from './modules/organizations/availability.ts'
import { controlPlaneHomeservers } from './modules/organizations/control-plane.ts'
import { registerDirectoryRoutes } from './modules/organizations/directory.ts'
import { configureHomeserver } from './modules/organizations/homeservers.ts'
import { settingsPlatformRoutes } from './modules/settings/events.ts'
import { registerSettingsRoutes } from './modules/settings/routes.ts'
import { scheduleDriveCommands } from './modules/spaces/drives.ts'
import { spacePlatformRoutes } from './modules/spaces/events.ts'
import { scheduleReconciliation } from './modules/spaces/reconcile.ts'
import {
  driveReplyRoutes,
  resourceActivityRoutes
} from './modules/spaces/resources.ts'
import { registerSpaceRoutes } from './modules/spaces/routes.ts'
import { cachedWorkplaces } from './modules/spaces/workplaces.ts'
import { registerSpaceWriteRoutes } from './modules/spaces/writes.ts'
import { registerTokenRoutes } from './modules/tokens/routes.ts'

// Readiness answers 503 this long before the server closes, so the load
// balancer stops routing here first. Both fit the default 30 s grace period.
const DRAIN_MS = 5000
const SHUTDOWN_DEADLINE_MS = 25_000

const PUBLISH_TIMEOUT_MS = 10_000

const config = loadConfig()
const logger = pino({ level: config.LOG_LEVEL })
const lifecycle = handleSignals({
  log: logger,
  deadlineMs: SHUTDOWN_DEADLINE_MS
})

const { sql, db } = createDb(config.DATABASE_URL)
await migrateDb(sql)
logger.info('database migrated')
let homeserverId: string | undefined
if (config.homeserver) {
  homeserverId = await configureHomeserver(db, config.homeserver)
}

const ldapRest = createLdapRestClient(config)
const directory = ldapRestDirectory(ldapRest)
const routes: Routes = {
  activity: {
    get: type =>
      resourceActivityRoutes.get(type) ??
      driveReplyRoutes.get(type) ??
      activityRoute.get(type)
  },
  platform: meetingOrganizations(
    {
      directory,
      homeserverId,
      tenants:
        config.controlPlane && controlPlaneHomeservers(config.controlPlane)
    },
    {
      get: key =>
        spacePlatformRoutes.get(key) ??
        organizationPlatformRoutes.get(key) ??
        settingsPlatformRoutes.get(key)
    }
  )
}

let accepting = false
const consumerStatus = consumerStats()
let isAlive = () => true
const server = createServer({
  logger,
  isReady: async () => accepting && (await sql`select 1`).length === 1,
  isAlive: () => isAlive()
})
const authorize = await setUpAuth(server, {
  db,
  oidc: {
    issuer: new URL(config.OIDC_ISSUER),
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    audience: config.OIDC_AUDIENCE
  },
  directory
})
registerSpaceRoutes(server, {
  db,
  authorize,
  apps: config.spaceApps,
  workplaces: cachedWorkplaces(directory),
  organizationDirectory: directory
})
const spaceDirectory = ldapRestSpaces(ldapRest)
registerSpaceWriteRoutes(server, {
  db,
  authorize,
  directory: spaceDirectory,
  organizationDirectory: directory
})
registerTokenRoutes(server, { db, authorize, directory })
registerDirectoryRoutes(server, { authorize, directory })
registerNotificationRoutes(server, {
  db,
  authorize,
  localpart: config.MATRIX_LOCALPART
})
registerFeedRoutes(server, { db, authorize })
registerLinkRoutes(server, { authorize })
// Publishing reuses the consumer's client, which starts after the server listens.
let publish: Publish = () => Promise.reject(new Error('not connected yet'))
registerMeetingRoutes(server, {
  db,
  authorize,
  publish: (...message) => publish(...message)
})
registerSettingsRoutes(server, { db, authorize })
const streams = createStreams()
registerLiveRoutes(server, { authorize, streams })
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })
const metrics = createServer({ logger, isReady: () => Promise.resolve(true) })
registerMetrics(metrics, { db, consumer: consumerStatus })
await metrics.listen({ host: config.HTTP_HOST, port: config.METRICS_PORT })

const handlerDeps = {
  dedupe: postgresDeduplicator(db, 'twake-space'),
  park: parkIn(db),
  logger
}
const handle = createMessageHandler({ routes, ...handlerDeps })
// Live updates first, so the changes the consumers commit reach browsers.
const consumers = await startConsumers(
  config,
  logger,
  {
    // It still drains the activity events older versions bound to it.
    space: handle,
    // The space queue handles provisioned events and drive replies.
    activity: createMessageHandler({
      routes: { ...routes, activity: activityRoute },
      ...handlerDeps
    })
  },
  consumerStatus,
  client => listenForLive(client, config.amqp.liveExchange, streams, logger)
)
const consumer = consumers.space
// The client waits for the broker without end and retries for over a minute,
// longer than a request should hang; a publish that lands late is harmless,
// the retry carries its uid.
const confirmed = (published: Promise<void>) =>
  Promise.race([
    published,
    delay(PUBLISH_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error('RabbitMQ did not confirm in time')
    })
  ])
// Mandatory: unroutable while no calendar consumer is bound, so the route
// fails instead of dropping the meeting.
publish = (routingKey, event, messageId) => {
  if (!consumer.isConnected()) {
    return Promise.reject(new Error('RabbitMQ is disconnected'))
  }
  return confirmed(
    consumer.publish(config.amqp.twakeSpaceExchange, routingKey, event, {
      messageId,
      mandatory: true
    })
  )
}
const connectToPublish = () =>
  amqplib.connect(config.AMQP_URL, { timeout: PUBLISH_TIMEOUT_MS })
const drives = sweepPublisher(
  connectToPublish,
  config.amqp.driveExchange,
  PUBLISH_TIMEOUT_MS
)
const stopDriveCommands = scheduleDriveCommands(
  db,
  command => drives.publish(config.amqp.driveRoutingKey, command),
  logger
)
const activity = sweepPublisher(
  connectToPublish,
  config.amqp.activityExchange,
  PUBLISH_TIMEOUT_MS
)
const stopActivity = scheduleActivity(db, activity.publish, logger)
isAlive = consumerAlive([consumers.space, consumers.activity], consumerStatus)
const stopParked = scheduleParkedRetries(
  db,
  handle,
  deadLetterQueue(consumer, config.amqp),
  logger
)
const stopPurge = schedulePurge(db, logger)
const stopSweep = scheduleRevocationSweep(db, streams, logger)
const stopReconciliation = scheduleReconciliation(db, spaceDirectory, logger)
accepting = true
lifecycle.started(async () => {
  accepting = false
  const parkedStopped = stopParked()
  stopPurge()
  stopSweep()
  const reconciliationStopped = stopReconciliation()
  const driveCommandsStopped = stopDriveCommands()
  const activityStopped = stopActivity()
  try {
    await Promise.all([
      parkedStopped,
      reconciliationStopped,
      driveCommandsStopped,
      activityStopped
    ])
    await Promise.all([
      consumers.space.close(),
      consumers.activity.close(),
      drives.close(),
      activity.close()
    ])
    await delay(DRAIN_MS)
    await server.close()
    await metrics.close()
    await sql.end({ timeout: 5 })
  } finally {
    await Sentry.close(2000)
  }
})
logger.info('twake-space backend started')
