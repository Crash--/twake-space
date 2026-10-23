import dns from 'node:dns'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPublicAddress } from './addresses.ts'
import { fetchPreview } from './preview.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Ignored when og:title is set</title>
<meta property="og:title" content="Roadmap &amp; plans">
<meta content="What comes next" name="description">
<meta property="og:site_name" content='Linagora'>
<meta property="og:image" content="/logo.png">
</head><body></body></html>`

let server: Server
let origin: string
beforeAll(async () => {
  server = createServer((request, response) => {
    const send = (type: string, body: string | Buffer) => {
      response.writeHead(200, { 'content-type': type }).end(body)
    }
    switch (request.url) {
      case '/page':
        send('text/html; charset=utf-8', PAGE)
        return
      case '/logo.png':
        send('image/png', PNG)
        return
      case '/moved':
        response.writeHead(302, { location: '/page' }).end()
        return
      case '/loop':
        response.writeHead(302, { location: '/loop' }).end()
        return
      case '/broken':
        response.writeHead(302, { location: 'http://[' }).end()
        return
      case '/inside':
        response.writeHead(302, { location: 'http://10.0.0.1/' }).end()
        return
      case '/json':
        send('application/json', '{"title":"no"}')
        return
      case '/untitled':
        send('text/html', '<html><head></head></html>')
        return
      case '/huge':
        send(
          'text/html',
          `<title>Huge</title><meta property="og:image" content="/big.png">${' '.repeat(2 * 1024 * 1024)}`
        )
        return
      case '/big.png':
        send('image/png', Buffer.alloc(300 * 1024))
        return
      default:
        response.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
afterAll(() => {
  server.close()
})

const local = { isPublic: () => true, anyPort: true }
const preview = (path: string) => fetchPreview(new URL(path, origin), local)

describe('fetchPreview', () => {
  it("reads a page's title, description, site and image", async () => {
    expect(await preview('/page')).toEqual({
      url: `${origin}/page`,
      title: 'Roadmap & plans',
      description: 'What comes next',
      site: 'Linagora',
      image: `data:image/png;base64,${PNG.toString('base64')}`
    })
  })

  it('follows a redirect and gives the page it lands on', async () => {
    expect((await preview('/moved'))?.url).toBe(`${origin}/page`)
  })

  it('gives up after a few redirects', async () => {
    expect(await preview('/loop')).toBeNull()
  })

  it('reads only the start of a large page, and leaves out a large image', async () => {
    expect(await preview('/huge')).toMatchObject({ title: 'Huge', image: null })
  })

  it.each(['/json', '/untitled', '/missing', '/broken'])(
    'has no preview for %s',
    async path => {
      expect(await preview(path)).toBeNull()
    }
  )

  it('refuses a loopback address', async () => {
    expect(
      await fetchPreview(new URL('/page', origin), { anyPort: true })
    ).toBeNull()
  })

  it('refuses a port other than 80 and 443', async () => {
    expect(
      await fetchPreview(new URL('/page', origin), { isPublic: () => true })
    ).toBeNull()
  })

  it('refuses a name that resolves to a private address', async () => {
    const lookup = ((
      _host: string,
      _options: unknown,
      callback: (error: null, addresses: dns.LookupAddress[]) => void
    ) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    }) as typeof dns.lookup
    const url = new URL(`http://intranet.test:${new URL(origin).port}/page`)

    expect(await fetchPreview(url, { anyPort: true, lookup })).toBeNull()
    expect(await fetchPreview(url, { ...local, lookup })).toMatchObject({
      title: 'Roadmap & plans'
    })
  })

  it('refuses a redirect to a private address', async () => {
    const guarded = {
      anyPort: true,
      isPublic: (address: string) =>
        address === '127.0.0.1' || isPublicAddress(address)
    }
    expect(await fetchPreview(new URL('/inside', origin), guarded)).toBeNull()
  })
})
