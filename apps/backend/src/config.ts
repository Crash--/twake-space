import { z } from 'zod'
import { amqpTopology, json } from './events/topology.ts'
import {
  NEW_TOKEN_CHECKS,
  NEW_TOKENS_WAITING
} from './modules/auth/authenticator.ts'
import {
  DEFAULT_LIMITS,
  type Limit,
  type LimitName
} from './modules/auth/limits.ts'
import { spaceApp } from './modules/spaces/resources.ts'

// Number('') is 0, so a blank value would pass as a count of zero.
const count = (min: number) =>
  z.string().trim().min(1).pipe(z.coerce.number<string>().int().min(min))

const HOMESERVER_KEYS = ['MATRIX_HOMESERVER_URL', 'MATRIX_SERVER_NAME'] as const
const CONTROL_PLANE_KEYS = [
  'CHAT_CONTROL_PLANE_URL',
  'CHAT_CONTROL_PLANE_TOKEN'
] as const

// A single installation sets its one homeserver, which serves every
// organization; SaaS sets the chat control plane, which gives each tenant's.
const homeserver = z
  .object({
    MATRIX_HOMESERVER_URL: z.url({ protocol: /^https?$/ }).optional(),
    MATRIX_SERVER_NAME: z.string().min(1).optional(),
    CHAT_CONTROL_PLANE_URL: z.url({ protocol: /^https?$/ }).optional(),
    CHAT_CONTROL_PLANE_TOKEN: z.string().min(1).optional()
  })
  .superRefine((env, ctx) => {
    const complain = (key: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [key], message })
    }
    const groups = [HOMESERVER_KEYS, CONTROL_PLANE_KEYS].map(keys => ({
      keys,
      missing: keys.filter(key => env[key] === undefined)
    }))
    const used = groups.filter(g => g.missing.length < g.keys.length)
    for (const { missing } of used) {
      for (const key of missing) complain(key, 'required with the others')
    }
    if (used.length === 2) {
      for (const key of CONTROL_PLANE_KEYS) {
        complain(key, 'not with a single homeserver')
      }
    }
  })
  .transform(env => {
    const {
      MATRIX_HOMESERVER_URL: url,
      MATRIX_SERVER_NAME: serverName,
      CHAT_CONTROL_PLANE_URL: controlPlaneUrl,
      CHAT_CONTROL_PLANE_TOKEN: controlPlaneToken
    } = env
    return {
      homeserver: url && serverName ? { url, serverName } : null,
      controlPlane:
        controlPlaneUrl && controlPlaneToken
          ? { url: controlPlaneUrl, token: controlPlaneToken }
          : null
    }
  })

const WINDOWS_MS = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000
}

// For example {"feedPost":"10/minute"}.
const rateLimits = json.pipe(
  z.partialRecord(
    z.enum(Object.keys(DEFAULT_LIMITS) as [LimitName, ...LimitName[]]),
    z
      .string()
      .regex(/^[1-9]\d*\/(second|minute|hour|day)$/, 'must be like 10/minute')
      .transform((value): Limit => {
        const [max, window] = value.split('/') as [
          string,
          keyof typeof WINDOWS_MS
        ]
        return { max: Number(max), perMs: WINDOWS_MS[window] }
      })
  )
)

const configSchema = z
  .object({
    AMQP_URL: z.url({ protocol: /^amqps?$/ }),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Rate limit counts; without it each replica keeps its own in memory.
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
    RATE_LIMITS: rateLimits.default({}),
    LDAP_REST_URL: z.url({ protocol: /^https?$/ }),
    LDAP_REST_SERVICE_ID: z.string().min(1),
    LDAP_REST_SECRET: z.string().min(32),
    OIDC_ISSUER: z.url({ protocol: /^https$/ }),
    OIDC_AUDIENCE: z.string().min(1).default('twakespace'),
    OIDC_CLIENT_ID: z.string().min(1).default('twakespace-backend'),
    OIDC_CLIENT_SECRET: z.string().min(1),
    NEW_TOKEN_CHECKS: count(1).default(NEW_TOKEN_CHECKS),
    NEW_TOKENS_WAITING: count(0).default(NEW_TOKENS_WAITING),
    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    // Kept off the public port.
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    MATRIX_LOCALPART: z.enum(['uid', 'email']).default('uid'),
    SPACE_APPS: z
      .string()
      .default(spaceApp.options.join(','))
      .transform(apps =>
        apps
          .split(',')
          .map(app => app.trim())
          .filter(Boolean)
      )
      .pipe(z.array(spaceApp))
  })
  .and(homeserver)
  .and(amqpTopology)
  .transform(({ SPACE_APPS, RATE_LIMITS, ...config }) => ({
    ...config,
    limits: { ...DEFAULT_LIMITS, ...RATE_LIMITS },
    // Chat's resource is a Matrix space, which needs a homeserver.
    spaceApps:
      config.homeserver || config.controlPlane
        ? SPACE_APPS
        : SPACE_APPS.filter(app => app !== 'chat')
  }))

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
