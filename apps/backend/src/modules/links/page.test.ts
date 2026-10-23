import { describe, expect, it } from 'vitest'
import { readPage } from './page.ts'

describe('readPage', () => {
  it('falls back on the title tag and the host name', () => {
    expect(
      readPage(
        '<TITLE> Hello\n  world </TITLE>',
        new URL('https://example.com/a')
      )
    ).toEqual({
      url: 'https://example.com/a',
      title: 'Hello world',
      description: null,
      site: 'example.com',
      imageUrl: null
    })
  })

  it('reads a page of unclosed tags in linear time', () => {
    const page = '<meta <title '.repeat(40_000)
    const started = performance.now()
    readPage(page, new URL('https://example.com/'))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
