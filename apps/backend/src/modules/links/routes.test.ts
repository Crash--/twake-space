import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from '../../infra/http.ts'
import { DEFAULT_LIMITS, fixedWindows } from '../auth/index.ts'
import { aTokenCaller, anIdentity, fakeAuth } from '../auth/testing.ts'
import type { LinkPreview } from './preview.ts'
import { cachedPreviews, registerLinkRoutes } from './routes.ts'

const found: LinkPreview = {
  url: 'https://example.com/a',
  title: 'Example',
  description: null,
  image: null,
  site: 'example.com'
}

function request(url: string, preview = vi.fn(), token = 'alice') {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  const authorize = fakeAuth(
    app,
    t => (t === 'alice' ? anIdentity() : null),
    t => (t === 'tws_bot' ? aTokenCaller() : null)
  )
  registerLinkRoutes(app, { authorize, fetchLimiter: () => 0, preview })
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` }
  })
}

describe('GET /link-preview', () => {
  it("answers the link's preview, its fragment left out", async () => {
    const preview = vi.fn().mockResolvedValue(found)

    const response = await request(
      `/link-preview?url=${encodeURIComponent('https://example.com/a#part')}`,
      preview
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(found)
    expect(preview).toHaveBeenCalledWith(
      new URL('https://example.com/a'),
      expect.any(Function)
    )
  })

  it('answers 404 when the link has no preview', async () => {
    const response = await request(
      '/link-preview?url=https://example.com/',
      vi.fn().mockResolvedValue(null)
    )

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'no_preview' })
  })

  it.each([
    '/link-preview',
    '/link-preview?url=ftp://example.com/',
    '/link-preview?url=javascript:alert(1)',
    `/link-preview?url=https://example.com/${'a'.repeat(2048)}`
  ])('refuses %s', async url => {
    const preview = vi.fn()

    expect((await request(url, preview)).statusCode).toBe(400)
    expect(preview).not.toHaveBeenCalled()
  })

  it('answers 429 once a person fetched 30 new links in the minute', async () => {
    const app = createServer({
      logger: pino({ level: 'silent' }),
      isReady: () => Promise.resolve(true)
    })
    const authorize = fakeAuth(app, () => anIdentity())
    const fetch = vi.fn().mockResolvedValue(found)
    let now = 0
    const limiter = fixedWindows(() => now)
    registerLinkRoutes(app, {
      authorize,
      fetchLimiter: key => limiter(key, DEFAULT_LIMITS.linkFetch),
      preview: cachedPreviews(fetch)
    })
    const get = (path: string) =>
      app.inject({
        method: 'GET',
        url: `/link-preview?url=https://example.com/${path}`,
        headers: { authorization: 'Bearer alice' }
      })

    for (let i = 0; i < 30; i++) await get(String(i))
    now = 45_000
    const limited = await get('new')

    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('15')
    expect((await get('0')).statusCode).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(30)
  })

  it('serves a person, not an API token', async () => {
    const response = await request(
      '/link-preview?url=https://example.com/',
      vi.fn(),
      'tws_bot'
    )

    expect(response.statusCode).toBe(403)
  })
})

describe('cachedPreviews', () => {
  const uncapped = (...args: Parameters<typeof cachedPreviews>) => {
    const preview = cachedPreviews(...args)
    return (url: URL) => preview(url, () => Promise.resolve(true))
  }

  it('fetches a link once for the hour, then again', async () => {
    let now = 0
    const fetch = vi.fn().mockResolvedValue(found)
    const preview = uncapped(fetch, () => now)
    const url = new URL('https://example.com/a')

    await Promise.all([preview(url), preview(url)])
    now = 60 * 60 * 1000 + 1
    await preview(url)

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('tries a link with no preview again after five minutes', async () => {
    let now = 0
    const fetch = vi.fn().mockResolvedValue(null)
    const preview = uncapped(fetch, () => now)
    const url = new URL('https://example.com/a')

    await preview(url)
    now = 4 * 60 * 1000
    await preview(url)
    now = 5 * 60 * 1000 + 1
    await preview(url)

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the latest links only', async () => {
    const fetch = vi.fn().mockResolvedValue(null)
    const preview = uncapped(fetch)

    for (let i = 0; i <= 200; i++) {
      await preview(new URL(`https://example.com/${String(i)}`))
    }
    await preview(new URL('https://example.com/0'))
    await preview(new URL('https://example.com/200'))

    expect(fetch).toHaveBeenCalledTimes(202)
  })

  it('asks before a fetch, never before answering from the cache', async () => {
    const fetch = vi.fn().mockResolvedValue(found)
    const preview = cachedPreviews(fetch)
    const url = new URL('https://example.com/a')

    await preview(url, () => Promise.resolve(true))

    expect(await preview(url, () => Promise.resolve(false))).toEqual(found)
    expect(
      await preview(new URL('https://example.com/b'), () =>
        Promise.resolve(false)
      )
    ).toBe('limited')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
