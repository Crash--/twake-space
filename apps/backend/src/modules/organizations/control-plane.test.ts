import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { controlPlaneHomeservers } from './control-plane.ts'

const seen: { url: string | undefined; auth: string | undefined }[] = []
const server = createServer((request, response) => {
  seen.push({ url: request.url, auth: request.headers.authorization })
  const chatUrl = request.url?.includes('org_chat')
    ? { chatUrl: 'https://chat-org_chat.example.com' }
    : request.url?.includes('org_bad')
      ? { chatUrl: 'chat' }
      : {}
  const status = /org_(acme|chat|bad)/.test(request.url ?? '')
    ? 200
    : request.url?.includes('org_down')
      ? 503
      : 404
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(
    status === 200
      ? JSON.stringify({
          homeserverUrl: 'https://matrix.acme.example.com',
          serverName: 'acme.example.com',
          asToken: 'as',
          hsToken: 'hs',
          ...chatUrl
        })
      : '{}'
  )
})
let url = ''
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, resolve))
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api`
})
afterAll(() => {
  server.close()
})

it("reads a tenant's homeserver, none while chat is not deployed", async () => {
  const tenants = controlPlaneHomeservers({ url, token: 'cp' })

  expect(await tenants.homeserverOf('org_acme')).toEqual({
    url: 'https://matrix.acme.example.com',
    serverName: 'acme.example.com',
    asToken: 'as',
    hsToken: 'hs'
  })
  expect(await tenants.homeserverOf('org_new')).toBeUndefined()
  await expect(tenants.homeserverOf('org_down')).rejects.toThrow('503')
  expect(seen[0]).toEqual({
    url: '/api/deployment/org_acme/twake-space',
    auth: 'Bearer cp'
  })
})

it("reads a tenant's Chat address when it has one", async () => {
  const tenants = controlPlaneHomeservers({ url, token: 'cp' })

  expect(await tenants.homeserverOf('org_chat')).toMatchObject({
    chatUrl: 'https://chat-org_chat.example.com'
  })
  expect(await tenants.homeserverOf('org_acme')).not.toHaveProperty('chatUrl')
})

it('keeps the homeserver when its Chat address is not a URL', async () => {
  const tenants = controlPlaneHomeservers({ url, token: 'cp' })

  expect(await tenants.homeserverOf('org_bad')).toMatchObject({
    hsToken: 'hs',
    chatUrl: undefined
  })
})
