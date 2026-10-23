import { z } from 'zod'
import type { HttpServer } from '../../infra/http.ts'
import type { Authorize } from '../auth/index.ts'
import { fetchPreview, type LinkPreview } from './preview.ts'

const CACHED_MS = 60 * 60 * 1000
const MISSED_MS = 5 * 60 * 1000
const CACHED_ENTRIES = 200

const previewQuery = z.object({
  url: z
    .url({ protocol: /^https?$/, normalize: true })
    .max(2048)
    .transform(url => {
      const parsed = new URL(url)
      parsed.hash = ''
      return parsed
    })
})

type Fetch = (url: URL) => Promise<LinkPreview | null>

// One fetch per link for the hour, whoever asks, also while it runs. A link
// with no preview is tried again sooner: the site may only have been slow. A Map
// keeps insertion order, so the first key is the oldest.
export function cachedPreviews(fetch: Fetch, now = Date.now): Fetch {
  const cache = new Map<
    string,
    { until: number; preview: Promise<LinkPreview | null> }
  >()
  return url => {
    const key = url.href
    const hit = cache.get(key)
    if (hit && hit.until > now()) return hit.preview
    cache.delete(key)
    const preview = fetch(url).catch(() => null)
    const entry = { until: now() + CACHED_MS, preview }
    cache.set(key, entry)
    void preview.then(found => {
      if (!found) entry.until = Math.min(entry.until, now() + MISSED_MS)
    })
    while (cache.size > CACHED_ENTRIES) {
      const [oldest] = cache.keys()
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return preview
  }
}

export function registerLinkRoutes(
  app: HttpServer,
  deps: { authorize: Authorize; preview?: Fetch }
) {
  const preview = deps.preview ?? cachedPreviews(url => fetchPreview(url))

  app.get(
    '/link-preview',
    { preHandler: deps.authorize() },
    async (request, reply) => {
      const query = previewQuery.safeParse(request.query)
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const found = await preview(query.data.url)
      if (!found) return reply.code(404).send({ error: 'no_preview' })
      return reply.header('cache-control', 'private, max-age=3600').send(found)
    }
  )
}
