import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from '../../infra/http.ts'
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
  registerLinkRoutes(app, { authorize, preview })
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
    expect(preview).toHaveBeenCalledWith(new URL('https://example.com/a'))
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
  it('fetches a link once for the hour, then again', async () => {
    let now = 0
    const fetch = vi.fn().mockResolvedValue(found)
    const preview = cachedPreviews(fetch, () => now)
    const url = new URL('https://example.com/a')

    await Promise.all([preview(url), preview(url)])
    now = 60 * 60 * 1000 + 1
    await preview(url)

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('tries a link with no preview again after five minutes', async () => {
    let now = 0
    const fetch = vi.fn().mockResolvedValue(null)
    const preview = cachedPreviews(fetch, () => now)
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
    const preview = cachedPreviews(fetch)

    for (let i = 0; i <= 200; i++) {
      await preview(new URL(`https://example.com/${String(i)}`))
    }
    await preview(new URL('https://example.com/0'))
    await preview(new URL('https://example.com/200'))

    expect(fetch).toHaveBeenCalledTimes(202)
  })
})
