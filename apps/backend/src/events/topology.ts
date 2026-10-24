import { z } from 'zod'

// Each platform event a handler exists for, and the exchange it is published
// on. Its routing key defaults to its name. The first one gives the queue's
// dead letter routing key, so it stays first.
export const PLATFORM_EVENTS = {
  'twake.space.created': 'space',
  'twake.space.updated': 'space',
  'twake.space.deleted': 'space',
  'twake.space.member.added': 'space',
  'twake.space.member.role.changed': 'space',
  'twake.space.member.removed': 'space',
  'twake.space.group.linked': 'space',
  'twake.space.group.role.changed': 'space',
  'twake.space.group.unlinked': 'space',
  'b2b.group.updated': 'b2b',
  'b2b.member.role.changed': 'b2b',
  'b2b.member.disabled': 'b2b',
  'domain.user.deleted': 'b2b',
  'domain.organization.deleted': 'b2b',
  'chat.deprovision': 'b2b',
  'chat.deployment.completed': 'b2b',
  'chat.deployment.updated': 'b2b',
  'dns.validated': 'admin-panel',
  'user.settings.updated': 'settings'
} as const

export type PlatformEventName = keyof typeof PLATFORM_EVENTS

export interface Binding {
  exchange: string
  routingKey: string
}

const names = Object.keys(PLATFORM_EVENTS) as [
  PlatformEventName,
  ...PlatformEventName[]
]

export const json = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be JSON' })
    return z.NEVER
  }
})

const overrides = json.pipe(
  z.partialRecord(
    z.enum(names),
    z.strictObject({
      exchange: z.string().min(1).optional(),
      // A message is translated back to its event by its exact key.
      routingKey: z
        .string()
        .regex(/^[^*#]+$/, 'must not hold a wildcard')
        .optional()
    })
  )
)

export const amqpTopology = z
  .object({
    AMQP_QUEUE: z.string().min(1).default('twake-space'),
    AMQP_DEAD_LETTER_EXCHANGE: z.string().min(1).optional(),
    AMQP_DELIVERY_LIMIT: z.coerce.number().int().min(1).default(20),
    AMQP_ACTIVITY_QUEUE: z.string().min(1).optional(),
    AMQP_ACTIVITY_DEAD_LETTER_EXCHANGE: z.string().min(1).optional(),
    AMQP_ACTIVITY_CONCURRENCY: z.coerce.number().int().min(1).default(10),
    AMQP_ACTIVITY_EXCHANGE: z.string().min(1).default('activity'),
    AMQP_SPACE_EXCHANGE: z.string().min(1).default('space'),
    AMQP_B2B_EXCHANGE: z.string().min(1).default('b2b'),
    AMQP_ADMIN_PANEL_EXCHANGE: z.string().min(1).default('admin-panel'),
    AMQP_SETTINGS_EXCHANGE: z.string().min(1).default('settings'),
    AMQP_TWAKE_SPACE_EXCHANGE: z.string().min(1).default('twake-space'),
    AMQP_LIVE_EXCHANGE: z.string().min(1).default('twake-space.live'),
    AMQP_DRIVE_EXCHANGE: z.string().min(1).default('drive'),
    AMQP_DRIVE_ROUTING_KEY: z
      .string()
      .regex(/^[^*#]+$/, 'must not hold a wildcard')
      .default('drive.org_drive.ensure'),
    AMQP_PROVISIONED_BINDING: z
      .string()
      .min(1)
      .default('com.twake.*.space.provisioned.v1'),
    AMQP_DRIVE_REPLIES_BINDING: z
      .string()
      .min(1)
      .default('com.twake.drive.org_drive.#'),
    AMQP_EVENTS: overrides.default({})
  })
  .transform((env, ctx) => {
    const exchanges = {
      space: env.AMQP_SPACE_EXCHANGE,
      b2b: env.AMQP_B2B_EXCHANGE,
      'admin-panel': env.AMQP_ADMIN_PANEL_EXCHANGE,
      settings: env.AMQP_SETTINGS_EXCHANGE
    }
    const events = Object.fromEntries(
      names.map(name => [
        name,
        {
          exchange:
            env.AMQP_EVENTS[name]?.exchange ?? exchanges[PLATFORM_EVENTS[name]],
          routingKey: env.AMQP_EVENTS[name]?.routingKey ?? name
        }
      ])
    ) as Record<PlatformEventName, Binding>
    const seen = new Map<string, PlatformEventName>()
    for (const name of names) {
      const { exchange, routingKey } = events[name]
      const key = `${exchange} ${routingKey}`
      const other = seen.get(key)
      if (other) {
        ctx.addIssue({
          code: 'custom',
          path: ['AMQP_EVENTS'],
          message: `${other} and ${name} share ${routingKey} on ${exchange}`
        })
      }
      seen.set(key, name)
      if (exchange === env.AMQP_ACTIVITY_EXCHANGE) {
        ctx.addIssue({
          code: 'custom',
          path: ['AMQP_ACTIVITY_EXCHANGE'],
          message: `${name} is bound on ${exchange} too`
        })
      }
    }
    const activityQueue =
      env.AMQP_ACTIVITY_QUEUE ?? `${env.AMQP_QUEUE}.activity`
    return {
      amqp: {
        platformQueue: `${env.AMQP_QUEUE}.platform`,
        deadLetterExchange:
          env.AMQP_DEAD_LETTER_EXCHANGE ?? `${env.AMQP_QUEUE}.dlx`,
        deliveryLimit: env.AMQP_DELIVERY_LIMIT,
        activityQueue,
        // Its own: the queue binds `#.dead` on it, which would catch every
        // other queue's dead letters too.
        activityDeadLetterExchange:
          env.AMQP_ACTIVITY_DEAD_LETTER_EXCHANGE ?? `${activityQueue}.dlx`,
        activityConcurrency: env.AMQP_ACTIVITY_CONCURRENCY,
        activityExchange: env.AMQP_ACTIVITY_EXCHANGE,
        twakeSpaceExchange: env.AMQP_TWAKE_SPACE_EXCHANGE,
        liveExchange: env.AMQP_LIVE_EXCHANGE,
        driveExchange: env.AMQP_DRIVE_EXCHANGE,
        driveRoutingKey: env.AMQP_DRIVE_ROUTING_KEY,
        provisionedBinding: env.AMQP_PROVISIONED_BINDING,
        driveRepliesBinding: env.AMQP_DRIVE_REPLIES_BINDING,
        events
      }
    }
  })

export type AmqpTopology = z.output<typeof amqpTopology>['amqp']
