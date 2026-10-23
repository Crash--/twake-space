import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isPublicAddress } from './addresses.ts'
import { readPage } from './page.ts'

export interface LinkPreview {
  url: string
  title: string
  description: string | null
  /** A data URL: the browser never asks the linked site for anything. */
  image: string | null
  site: string
}

const PAGE_BYTES = 512 * 1024
const IMAGE_BYTES = 200 * 1024
const TIMEOUT_MS = 5000
const REDIRECTS = 3
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])

export interface FetchOptions {
  lookup?: typeof dns.lookup
  isPublic?: (address: string) => boolean
  anyPort?: boolean
}

// The address is checked where the socket connects, so a DNS answer that
// changes between a check and the connection cannot reach a private one.
function guardedLookup(
  lookup: typeof dns.lookup,
  isPublic: (address: string) => boolean
): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '')
        return
      }
      const [first] = addresses
      if (!first || !addresses.every(a => isPublic(a.address))) {
        callback(new Error(`${hostname} is not a public address`), '')
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, first.address, first.family)
    })
  }
}

interface Fetched {
  url: URL
  type: string
  charset: string | null
  body: Buffer
}

function getOnce(
  url: URL,
  accept: string,
  maxBytes: number,
  truncate: boolean,
  signal: AbortSignal,
  options: Required<FetchOptions>
): Promise<{ redirect: URL } | Fetched | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 && !options.isPublic(host)) {
    return Promise.reject(new Error(`${host} is not a public address`))
  }
  const request = url.protocol === 'https:' ? https.request : http.request
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      {
        signal,
        agent: false,
        lookup: guardedLookup(options.lookup, options.isPublic),
        headers: { accept, 'user-agent': 'TwakeSpace-LinkPreview/1.0' }
      },
      response => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && location) {
          response.resume()
          const next = URL.parse(location, url.href)
          resolve(next && { redirect: next })
          return
        }
        const [type = '', ...params] = (response.headers['content-type'] ?? '')
          .split(';')
          .map(part => part.trim())
        const length = Number(response.headers['content-length'])
        if (status !== 200 || (!truncate && length > maxBytes)) {
          response.destroy()
          resolve(null)
          return
        }
        const charset =
          params
            .find(p => p.toLowerCase().startsWith('charset='))
            ?.slice(8)
            .replace(/"/g, '') ?? null
        const chunks: Buffer[] = []
        let size = 0
        const done = () => {
          resolve({
            url,
            type: type.toLowerCase(),
            charset,
            body: Buffer.concat(chunks).subarray(0, maxBytes)
          })
        }
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          size += chunk.length
          if (size <= maxBytes) return
          response.destroy()
          if (truncate) done()
          else resolve(null)
        })
        response.on('end', done)
        response.on('error', reject)
      }
    )
    sent.on('error', reject)
    sent.end()
  })
}

async function get(
  start: URL,
  accept: string,
  maxBytes: number,
  truncate: boolean,
  signal: AbortSignal,
  options: Required<FetchOptions>
): Promise<Fetched | null> {
  let url = start
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!options.anyPort && !['', '80', '443'].includes(url.port)) return null
    const got = await getOnce(url, accept, maxBytes, truncate, signal, options)
    if (!got || !('redirect' in got)) return got
    url = got.redirect
  }
  return null
}

function decode(page: Fetched): string {
  const head = page.body.subarray(0, 2048).toString('latin1')
  const declared =
    page.charset ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(page.body)
  } catch {
    return new TextDecoder().decode(page.body)
  }
}

/** Null when the page cannot be read, is not HTML or has no title. */
export async function fetchPreview(
  url: URL,
  options: FetchOptions = {}
): Promise<LinkPreview | null> {
  const settled = {
    lookup: options.lookup ?? dns.lookup,
    isPublic: options.isPublic ?? isPublicAddress,
    anyPort: options.anyPort ?? false
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const page = await get(
    url,
    'text/html,application/xhtml+xml',
    PAGE_BYTES,
    true,
    signal,
    settled
  ).catch(() => null)
  if (!page || !['text/html', 'application/xhtml+xml'].includes(page.type)) {
    return null
  }
  const { imageUrl, ...read } = readPage(decode(page), page.url)
  if (!read.title) return null
  const picture = imageUrl
    ? await get(imageUrl, 'image/*', IMAGE_BYTES, false, signal, settled).catch(
        () => null
      )
    : null
  return {
    ...read,
    image:
      picture && IMAGE_TYPES.has(picture.type)
        ? `data:${picture.type};base64,${picture.body.toString('base64')}`
        : null
  }
}
