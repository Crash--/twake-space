import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = {
  AMQP_URL: 'amqp://guest:guest@localhost:5672',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  LDAP_REST_URL: 'http://localhost:8081',
  LDAP_REST_SERVICE_ID: 'twake-space',
  LDAP_REST_SECRET: 'x'.repeat(32),
  OIDC_ISSUER: 'https://sso.example.com/',
  OIDC_CLIENT_SECRET: 'secret'
}

const homeserver = {
  MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
  MATRIX_SERVER_NAME: 'example.com',
  MATRIX_AS_TOKEN: 'as',
  MATRIX_HS_TOKEN: 'hs',
  SECRETS_KEY: randomBytes(32).toString('base64')
}

const controlPlane = {
  CHAT_CONTROL_PLANE_URL: 'https://control-plane.example.com',
  CHAT_CONTROL_PLANE_TOKEN: 'cp'
}

describe('loadConfig', () => {
  it('refuses a broker URL that is not AMQP', () => {
    expect(() =>
      loadConfig({ ...base, AMQP_URL: 'kafka://localhost:9092' })
    ).toThrow('AMQP_URL')
  })

  it('has no homeserver unless one is configured', () => {
    expect(loadConfig(base).homeserver).toBeNull()
  })

  it('reads a configured homeserver and its key', () => {
    expect(loadConfig({ ...base, ...homeserver }).homeserver).toEqual({
      url: 'https://matrix.example.com',
      serverName: 'example.com',
      asToken: 'as',
      hsToken: 'hs',
      key: Buffer.from(homeserver.SECRETS_KEY, 'base64')
    })
  })

  it('refuses a homeserver configured in part', () => {
    expect(() =>
      loadConfig({ ...base, ...homeserver, MATRIX_HS_TOKEN: undefined })
    ).toThrow('MATRIX_HS_TOKEN')
  })

  it('reads the chat control plane that gives each tenant its homeserver', () => {
    const config = loadConfig({
      ...base,
      ...controlPlane,
      SECRETS_KEY: homeserver.SECRETS_KEY
    })

    expect(config.homeserver).toBeNull()
    expect(config.controlPlane).toEqual({
      url: 'https://control-plane.example.com',
      token: 'cp',
      key: Buffer.from(homeserver.SECRETS_KEY, 'base64')
    })
  })

  it('refuses a control plane configured in part, or with a homeserver', () => {
    expect(() =>
      loadConfig({
        ...base,
        CHAT_CONTROL_PLANE_URL: controlPlane.CHAT_CONTROL_PLANE_URL
      })
    ).toThrow('CHAT_CONTROL_PLANE_TOKEN')
    expect(() => loadConfig({ ...base, ...controlPlane })).toThrow(
      'SECRETS_KEY'
    )
    expect(() =>
      loadConfig({ ...base, ...homeserver, ...controlPlane })
    ).toThrow('CHAT_CONTROL_PLANE_URL')
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...base, ...homeserver, SECRETS_KEY: 'c2hvcnQ=' })
    ).toThrow('SECRETS_KEY')
  })
})

describe('loadConfig: space apps', () => {
  it('provides every app by default', () => {
    expect(loadConfig({ ...base, ...homeserver }).spaceApps).toEqual([
      'chat',
      'tasks',
      'drive',
      'mail',
      'calendar'
    ])
  })

  it('provides only the listed apps', () => {
    const config = loadConfig({
      ...base,
      ...homeserver,
      SPACE_APPS: 'tasks, chat'
    })

    expect(config.spaceApps).toEqual(['tasks', 'chat'])
  })

  it('leaves chat out without a homeserver or a control plane', () => {
    expect(loadConfig({ ...base, SPACE_APPS: 'chat,tasks' }).spaceApps).toEqual(
      ['tasks']
    )
  })

  it('refuses an app it does not know', () => {
    expect(() => loadConfig({ ...base, SPACE_APPS: 'tasks,wiki' })).toThrow(
      'SPACE_APPS'
    )
  })
})

describe('loadConfig: RabbitMQ topology', () => {
  it('names the queue, exchanges and keys after the platform by default', () => {
    const { amqp } = loadConfig(base)

    expect(amqp).toMatchObject({
      queue: 'twake-space',
      deadLetterExchange: 'twake-space.dlx',
      deliveryLimit: 20,
      activityQueue: 'twake-space.activity',
      activityDeadLetterExchange: 'twake-space.activity.dlx',
      activityConcurrency: 10,
      activityExchange: 'activity',
      driveExchange: 'drive',
      driveRoutingKey: 'drive.org_drive.ensure',
      provisionedBinding: 'com.twake.*.space.provisioned.v1',
      driveRepliesBinding: 'com.twake.drive.org_drive.#'
    })
    expect(amqp.events['twake.space.created']).toEqual({
      exchange: 'space',
      routingKey: 'twake.space.created'
    })
    expect(amqp.events['domain.user.deleted']).toEqual({
      exchange: 'b2b',
      routingKey: 'domain.user.deleted'
    })
    expect(amqp.events['dns.validated']).toEqual({
      exchange: 'admin-panel',
      routingKey: 'dns.validated'
    })
    expect(amqp.events['user.settings.updated']).toEqual({
      exchange: 'settings',
      routingKey: 'user.settings.updated'
    })
  })

  it('renames the queue, its dead letter exchange and the exchanges', () => {
    const { amqp } = loadConfig({
      ...base,
      AMQP_QUEUE: 'space-events',
      AMQP_DELIVERY_LIMIT: '5',
      AMQP_ACTIVITY_EXCHANGE: 'apps',
      AMQP_B2B_EXCHANGE: 'b2b-saas',
      AMQP_SETTINGS_EXCHANGE: 'common-settings',
      AMQP_TWAKE_SPACE_EXCHANGE: 'space-commands',
      AMQP_DRIVE_EXCHANGE: 'twake-space.drive',
      AMQP_DRIVE_ROUTING_KEY: 'twake-space.drive.ensure',
      AMQP_PROVISIONED_BINDING: 'apps.*.provisioned',
      AMQP_DRIVE_REPLIES_BINDING: 'apps.drive.replies.#'
    })

    expect(amqp).toMatchObject({
      driveRoutingKey: 'twake-space.drive.ensure',
      provisionedBinding: 'apps.*.provisioned',
      driveRepliesBinding: 'apps.drive.replies.#',
      queue: 'space-events',
      deadLetterExchange: 'space-events.dlx',
      activityQueue: 'space-events.activity',
      activityDeadLetterExchange: 'space-events.activity.dlx',
      deliveryLimit: 5,
      activityExchange: 'apps',
      twakeSpaceExchange: 'space-commands',
      driveExchange: 'twake-space.drive'
    })
    expect(amqp.events['b2b.group.updated'].exchange).toBe('b2b-saas')
    expect(amqp.events['user.settings.updated'].exchange).toBe(
      'common-settings'
    )
    expect(amqp.events['twake.space.created'].exchange).toBe('space')
  })

  it('moves one event to another exchange or routing key', () => {
    const { amqp } = loadConfig({
      ...base,
      AMQP_EVENTS: JSON.stringify({
        'chat.deployment.completed': {
          exchange: 'chat',
          routingKey: 'deployment.completed'
        },
        'chat.deployment.updated': {
          exchange: 'chat',
          routingKey: 'deployment.updated'
        },
        'dns.validated': { routingKey: 'domain.dns.validated' }
      })
    })

    expect(amqp.events['chat.deployment.completed']).toEqual({
      exchange: 'chat',
      routingKey: 'deployment.completed'
    })
    expect(amqp.events['chat.deployment.updated']).toEqual({
      exchange: 'chat',
      routingKey: 'deployment.updated'
    })
    expect(amqp.events['dns.validated']).toEqual({
      exchange: 'admin-panel',
      routingKey: 'domain.dns.validated'
    })
  })

  it('refuses an event it has no handler for, or two events on one key', () => {
    expect(() =>
      loadConfig({
        ...base,
        AMQP_EVENTS: JSON.stringify({ 'chat.unknown': { routingKey: 'x' } })
      })
    ).toThrow('AMQP_EVENTS')
    expect(() =>
      loadConfig({
        ...base,
        AMQP_EVENTS: JSON.stringify({
          'b2b.group.updated': { routingKey: 'b2b.member.disabled' }
        })
      })
    ).toThrow('AMQP_EVENTS')
    expect(() => loadConfig({ ...base, AMQP_EVENTS: '{' })).toThrow(
      'AMQP_EVENTS'
    )
  })

  it('refuses a wildcard key, or platform events on the activity exchange', () => {
    expect(() =>
      loadConfig({
        ...base,
        AMQP_EVENTS: JSON.stringify({
          'dns.validated': { routingKey: 'dns.#' }
        })
      })
    ).toThrow('AMQP_EVENTS')
    expect(() =>
      loadConfig({ ...base, AMQP_DRIVE_ROUTING_KEY: 'drive.#' })
    ).toThrow('AMQP_DRIVE_ROUTING_KEY')
    expect(() =>
      loadConfig({ ...base, AMQP_ACTIVITY_EXCHANGE: 'b2b' })
    ).toThrow('AMQP_ACTIVITY_EXCHANGE')
  })
})
