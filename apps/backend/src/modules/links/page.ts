export interface Page {
  url: string
  title: string
  description: string | null
  site: string
  imageUrl: URL | null
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (entity, name: string) => {
      const code = name.startsWith('#x')
        ? parseInt(name.slice(2), 16)
        : name.startsWith('#')
          ? parseInt(name.slice(1), 10)
          : undefined
      if (code === undefined) return ENTITIES[name.toLowerCase()] ?? entity
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
  )
}

function clean(text: string | undefined, max: number): string | null {
  if (text === undefined) return null
  const cleaned = decodeEntities(text).replace(/\s+/g, ' ').trim()
  return cleaned ? Array.from(cleaned).slice(0, max).join('') : null
}

/** Its title is empty when the page has none. */
export function readPage(html: string, url: URL): Page {
  const meta = new Map<string, string>()
  // A tag stops at the next `<`: with `[^>]*`, each unclosed tag of a page
  // would scan to its end, seconds of blocked event loop.
  for (const [tag] of html.matchAll(/<meta\s[^<>]*>/gi)) {
    const attributes = new Map<string, string>()
    for (const match of tag.matchAll(
      /([a-z:-]{1,64})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
    )) {
      const [, name = '', double, single, bare] = match
      attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
    }
    const key = (attributes.get('property') ?? attributes.get('name'))
      ?.toLowerCase()
      .trim()
    const content = attributes.get('content')
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
  }
  const first = (...keys: string[]) =>
    keys.map(key => meta.get(key)).find(value => value?.trim())
  const titleTag = /<title[^<>]*>([^<]*)<\/title>/i.exec(html)?.[1]
  const image = first('og:image:secure_url', 'og:image', 'twitter:image')
  const imageUrl = image
    ? URL.parse(decodeEntities(image.trim()), url.href)
    : null
  return {
    url: url.href,
    title: clean(first('og:title', 'twitter:title') ?? titleTag, 200) ?? '',
    description: clean(
      first('og:description', 'twitter:description', 'description'),
      300
    ),
    site: clean(first('og:site_name'), 100) ?? url.hostname,
    imageUrl
  }
}
