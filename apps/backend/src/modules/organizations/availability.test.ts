import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { PlatformEvent } from '../../events/envelope.ts'
import { NotYetKnownError, type Handler } from '../../events/router.ts'
import { lastChanges } from '../../events/schema.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import { decrypt, hashSecret } from '../../infra/secrets.ts'
import { createTestDb, type TestDb } from '../../infra/testing.ts'
import {
  meetingOrganizations,
  organizationPlatformRoutes
} from './availability.ts'
import type { TenantHomeservers } from './control-plane.ts'
import { configureHomeserver } from './homeservers.ts'
import { homeservers, organizations } from './schema.ts'

let testDb: TestDb
beforeAll(async () => {
  testDb = await createTestDb()
})
afterAll(() => testDb.drop())

beforeEach(async () => {
  await testDb.db.delete(organizations)
  await testDb.db.delete(homeservers)
  await testDb.db.delete(lastChanges)
})

const KEY = randomBytes(32)

function setUp(
  found: Awaited<ReturnType<Directory['organization']>>,
  homeserverId?: string,
  homeservers?: TenantHomeservers
) {
  const directory = { organization: vi.fn(() => Promise.resolve(found)) }
  const other = vi.fn<Handler<PlatformEvent>>(() => Promise.resolve())
  const routes = meetingOrganizations(
    {
      directory,
      homeserverId,
      tenants: homeservers && { homeservers, key: KEY }
    },
    {
      get: key =>
        organizationPlatformRoutes.get(key) ??
        (key === 'twake.space.created' ? other : undefined)
    }
  )
  const handle = (routingKey: string, body: unknown) => {
    const handler = routes.get(routingKey)
    if (!handler) throw new Error(`no handler for ${routingKey}`)
    const event: PlatformEvent = { routingKey, messageId: 'msg-1', body }
    return testDb.db.transaction(tx =>
      handler(event, tx, pino({ level: 'silent' }))
    )
  }
  return { directory, other, handle }
}

const stored = () =>
  testDb.db
    .select({
      organizationId: organizations.organizationId,
      domain: organizations.domain,
      chat: organizations.chatAvailable,
      mail: organizations.mailAvailable
    })
    .from(organizations)

const acme = { domain: 'acme.example.com', chat: true, mail: false }

it('reads an organization from the directory the first time it is seen', async () => {
  const { directory, other, handle } = setUp(acme)

  await handle('twake.space.created', { organizationId: 'org_acme' })
  await handle('twake.space.created', { organizationId: 'org_acme' })

  expect(await stored()).toEqual([{ organizationId: 'org_acme', ...acme }])
  expect(directory.organization).toHaveBeenCalledOnce()
  expect(other).toHaveBeenCalledTimes(2)
})

it("points a new organization to a single installation's homeserver", async () => {
  const homeserverId = await configureHomeserver(testDb.db, randomBytes(32), {
    url: 'https://matrix.example.com',
    serverName: 'example.com',
    asToken: 'as',
    hsToken: 'hs'
  })
  const { handle } = setUp(acme, homeserverId)

  await handle('twake.space.created', { organizationId: 'org_acme' })

  expect(
    await testDb.db
      .select({ homeserverId: organizations.homeserverId })
      .from(organizations)
  ).toEqual([{ homeserverId }])
})

const tenantHomeserver = (hsToken: string) => ({
  url: 'https://matrix.acme.example.com',
  serverName: 'acme.example.com',
  asToken: 'as',
  hsToken
})

const linked = async () => {
  const rows = await testDb.db
    .select({
      homeserverId: organizations.homeserverId,
      url: homeservers.url,
      serverName: homeservers.serverName,
      asToken: homeservers.asToken,
      hsTokenHash: homeservers.hsTokenHash
    })
    .from(organizations)
    .leftJoin(homeservers, eq(homeservers.id, organizations.homeserverId))
  return rows.map(({ asToken, ...row }) => ({
    ...row,
    asToken: asToken && decrypt(KEY, asToken)
  }))
}

it("fetches a new organization's homeserver from the chat control plane", async () => {
  const homeserverOf = vi.fn(() => Promise.resolve(tenantHomeserver('hs')))
  const { handle } = setUp(acme, undefined, { homeserverOf })

  await handle('twake.space.created', { organizationId: 'org_acme' })

  expect(homeserverOf).toHaveBeenCalledWith('org_acme')
  expect(await linked()).toEqual([
    {
      homeserverId: expect.any(String) as string,
      url: 'https://matrix.acme.example.com',
      serverName: 'acme.example.com',
      asToken: 'as',
      hsTokenHash: hashSecret('hs')
    }
  ])
})

it('refreshes the homeserver on each chat deployment', async () => {
  const homeserverOf = vi
    .fn<TenantHomeservers['homeserverOf']>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(tenantHomeserver('hs-1'))
    .mockResolvedValueOnce(tenantHomeserver('hs-2'))
  const { handle } = setUp({ ...acme, chat: false }, undefined, {
    homeserverOf
  })
  const deployed = () =>
    handle('chat.deployment.completed', {
      organizationId: 'org_acme',
      deployment: { completedAt: '2026-10-05T09:00:00Z' }
    })

  await handle('twake.space.created', { organizationId: 'org_acme' })
  const before = await linked()
  await deployed()
  const [first] = await linked()
  await deployed()

  expect(before).toMatchObject([{ homeserverId: null }])
  expect(first).toMatchObject({ hsTokenHash: hashSecret('hs-1') })
  expect(await linked()).toEqual([
    { ...first, hsTokenHash: hashSecret('hs-2') }
  ])
  expect(await testDb.db.$count(homeservers)).toBe(1)
})

it("keeps the tenant's Chat address with its homeserver, as the control plane gives it", async () => {
  const homeserverOf = vi
    .fn<TenantHomeservers['homeserverOf']>()
    .mockResolvedValueOnce({
      ...tenantHomeserver('hs'),
      chatUrl: 'https://chat-org_acme.example.com'
    })
    .mockResolvedValueOnce(tenantHomeserver('hs'))
  const { handle } = setUp(acme, undefined, { homeserverOf })
  const chatUrls = () =>
    testDb.db.select({ chatUrl: homeservers.chatUrl }).from(homeservers)

  await handle('twake.space.created', { organizationId: 'org_acme' })
  const met = await chatUrls()
  await handle('chat.deployment.completed', {
    organizationId: 'org_acme',
    deployment: { completedAt: '2026-10-05T09:00:00Z' }
  })

  expect(met).toEqual([{ chatUrl: 'https://chat-org_acme.example.com' }])
  expect(await chatUrls()).toEqual([{ chatUrl: null }])
})

it('refreshes the homeserver on a chat update, leaving chat as it is', async () => {
  const homeserverOf = vi
    .fn<TenantHomeservers['homeserverOf']>()
    .mockResolvedValueOnce(tenantHomeserver('hs-1'))
    .mockResolvedValueOnce({
      ...tenantHomeserver('hs-2'),
      chatUrl: 'https://chat-org_acme.example.com'
    })
  const { handle } = setUp({ ...acme, chat: false }, undefined, {
    homeserverOf
  })

  await handle('twake.space.created', { organizationId: 'org_acme' })
  await handle('chat.deployment.updated', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    deployment: { status: 'succeeded', completedAt: '2026-10-05T09:00:00Z' }
  })

  expect(await linked()).toMatchObject([{ hsTokenHash: hashSecret('hs-2') }])
  expect(
    await testDb.db.select({ chatUrl: homeservers.chatUrl }).from(homeservers)
  ).toEqual([{ chatUrl: 'https://chat-org_acme.example.com' }])
  expect(await stored()).toMatchObject([{ chat: false }])
})

it('waits for the chat control plane on a chat update', async () => {
  const homeserverOf = vi.fn(() => Promise.reject(new Error('503')))
  const { handle } = setUp(acme, undefined, { homeserverOf })
  await handle('twake.space.created', { organizationId: 'org_acme' })

  await expect(
    handle('chat.deployment.updated', { organizationId: 'org_acme' })
  ).rejects.toBeInstanceOf(NotYetKnownError)
})

it('handles the event of a new organization when the chat control plane fails', async () => {
  const homeserverOf = vi.fn(() => Promise.reject(new Error('503')))
  const { other, handle } = setUp(acme, undefined, { homeserverOf })

  await handle('twake.space.created', { organizationId: 'org_acme' })

  expect(other).toHaveBeenCalledOnce()
  expect(await linked()).toMatchObject([{ homeserverId: null }])
})

it('waits for the chat control plane on a chat deployment', async () => {
  const homeserverOf = vi.fn(() => Promise.reject(new Error('503')))
  const { handle } = setUp(acme, undefined, { homeserverOf })
  await handle('twake.space.created', { organizationId: 'org_acme' })

  await expect(
    handle('chat.deployment.completed', {
      organizationId: 'org_acme',
      deployment: { completedAt: '2026-10-05T09:00:00Z' }
    })
  ).rejects.toBeInstanceOf(NotYetKnownError)
})

it('keeps an organization the directory does not have out of the copy', async () => {
  const { other, handle } = setUp(undefined)

  await handle('twake.space.created', { organizationId: 'org_ghost' })

  expect(await stored()).toEqual([])
  expect(other).toHaveBeenCalledOnce()
})

it('turns chat on when its deployment succeeds', async () => {
  const { handle } = setUp({ ...acme, chat: false })

  await handle('chat.deployment.completed', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    deployment: { status: 'failed', completedAt: '2026-10-05T09:00:00Z' }
  })
  const afterFailure = await stored()
  await handle('chat.deployment.completed', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    deployment: { status: 'succeeded', completedAt: '2026-10-05T09:10:00Z' }
  })

  expect(afterFailure).toMatchObject([{ chat: false }])
  expect(await stored()).toMatchObject([{ chat: true }])
})

it('takes a deployment without a status as a success', async () => {
  const { handle } = setUp({ ...acme, chat: false })

  await handle('chat.deployment.completed', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    deployment: {
      deploymentId: 'deploy_1',
      startedAt: '2026-10-05T08:50:00Z',
      completedAt: '2026-10-05T09:00:00Z',
      endpoints: {}
    }
  })

  expect(await stored()).toMatchObject([{ chat: true }])
})

it('turns chat off when it is deprovisioned, whatever order the events come in', async () => {
  const { handle } = setUp(acme)

  await handle('chat.deprovision', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    reason: 'disabled by admin',
    timestamp: '2026-10-05T10:00:00Z'
  })
  await handle('chat.deployment.completed', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    deployment: { status: 'succeeded', completedAt: '2026-10-05T09:00:00Z' }
  })

  expect(await stored()).toMatchObject([{ chat: false }])
})

it('sets mail from the DNS validation', async () => {
  const { handle } = setUp(acme)

  await handle('dns.validated', {
    organizationId: 'org_acme',
    domain: 'acme.example.com',
    dnsOwnershipValidated: true,
    chatDnsConfigurationValidated: false,
    mailDnsConfigurationValidated: true
  })

  expect(await stored()).toMatchObject([{ chat: true, mail: true }])
})
