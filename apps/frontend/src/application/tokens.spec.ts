import { describe, expect, it } from 'vitest'

import {
  agentBrief,
  curlExample,
  scopesOf,
  tokenResources
} from '@/application/tokens'

describe('scopesOf', () => {
  it('grants read with write', () => {
    expect(
      scopesOf({
        spaces: 'write',
        feed: 'write',
        members: 'none',
        notifications: 'read',
        tokens: 'write'
      })
    ).toEqual([
      'space:read',
      'space:write',
      'feed:read',
      'feed:write',
      'notifications:read',
      'tokens:write'
    ])
  })

  it('grants nothing without access', () => {
    expect(
      scopesOf({
        spaces: 'none',
        feed: 'none',
        members: 'none',
        notifications: 'none',
        tokens: 'none'
      })
    ).toEqual([])
  })
})

describe('tokenResources', () => {
  it('leaves notifications out of an organization token', () => {
    expect(tokenResources('personal')).toContain('notifications')
    expect(tokenResources('organization')).not.toContain('notifications')
  })
})

describe('agentBrief', () => {
  const created = {
    id: 't-1',
    name: 'Assistant',
    token: 'tws_x',
    scopes: ['feed:write' as const],
    spaces: 'all' as const,
    role: null,
    expiresAt: null
  }

  it('tells the agent how to read its own token and who signs its posts', () => {
    const brief = agentBrief('https://space.test/api', created)

    expect(brief).toContain('- GET /tokens/self')
    expect(brief).toContain('- POST /spaces/:spaceId/feed/posts')
    expect(brief).toContain('Posts are signed "Assistant"')
  })
})

describe('curlExample', () => {
  it.each(['https://space.test/api', 'https://space.test/api/'])(
    'keeps the API path of %s',
    apiUrl => {
      expect(curlExample(apiUrl, 'tws_x')).toBe(
        'curl -H "Authorization: Bearer tws_x" https://space.test/api/spaces'
      )
    }
  )
})
