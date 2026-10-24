import { describe, expect, it } from 'vitest'

import { memoryDirectory } from '@/adapters/memory/memoryDirectory'
import { memoryFeed } from '@/adapters/memory/memoryFeed'
import { memorySpaces } from '@/adapters/memory/memorySpaces'
import { memoryTokens } from '@/adapters/memory/memoryTokens'
import type { FeedItem } from '@/application/feed'
import type { Space } from '@/application/spaces'

const roadmap: Space = {
  id: 'roadmap',
  name: 'Roadmap',
  role: 'admin',
  createdAt: '2026-10-01T08:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: true,
  apps: ['chat'],
  chat: true,
  mail: true,
  homeserverUrl: 'https://matrix.acme.test',
  chatUrl: null,
  banner: null,
  members: [
    {
      id: 'u-alice',
      username: 'alice',
      email: 'alice@acme.test',
      displayName: null,
      workplaceFqdn: null,
      role: 'admin'
    }
  ],
  groups: [],
  resources: [{ kind: 'matrix_space', id: '!roadmap:acme.test' }]
}

const people = [
  {
    id: 'u-alice',
    username: 'alice',
    email: 'alice@acme.test',
    displayName: 'Alice Martin'
  },
  {
    id: 'u-bob',
    username: 'bob',
    email: 'bob@acme.test',
    displayName: 'Bob Durand'
  }
]
const groups = [{ id: 'g-designers', name: 'Designers' }]

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 7, 8, minute)).toISOString()

const message = (minute: number): FeedItem => ({
  id: `m${String(minute)}`,
  kind: 'post',
  category: 'messages',
  time: at(minute),
  updatedAt: at(minute),
  reactions: [],
  author: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
  body: `Message ${String(minute)}`,
  editedAt: null,
  poll: null,
  approval: null
})

const file: FeedItem = {
  id: 'file',
  kind: 'card',
  category: 'files',
  time: at(50),
  updatedAt: at(50),
  reactions: [],
  type: 'com.twake.drive.file.created.v1',
  actor: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
  object: { type: 'file', id: 'f-1', title: 'brief.pdf', container: null },
  preview: null,
  state: {},
  files: null
}

describe('memorySpaces', () => {
  it('edits and removes a space', async () => {
    const spaces = memorySpaces([roadmap], { people, groups })

    await spaces.edit('roadmap', { name: 'Roadmap 2027' })
    await spaces.edit('roadmap', { apps: ['calendar'] })
    expect(await spaces.get('roadmap')).toMatchObject({
      name: 'Roadmap 2027',
      apps: ['calendar']
    })
    await spaces.setState('roadmap', 'trashed')
    await spaces.remove('roadmap')
    expect(await spaces.shelved('trashed')).toEqual([])
  })

  it('adds, changes and removes members', async () => {
    const spaces = memorySpaces([roadmap], { people, groups })

    await spaces.addMembers('roadmap', ['bob'], 'viewer')
    await spaces.setMemberRole('roadmap', 'u-bob', 'editor')
    expect((await spaces.get('roadmap')).members).toContainEqual({
      id: 'u-bob',
      username: 'bob',
      email: 'bob@acme.test',
      displayName: 'Bob Durand',
      workplaceFqdn: null,
      role: 'editor'
    })
    await spaces.removeMember('roadmap', 'u-bob')
    expect((await spaces.get('roadmap')).members).toHaveLength(1)
  })

  it('links, changes and unlinks groups', async () => {
    const spaces = memorySpaces([roadmap], { people, groups })

    await spaces.linkGroups('roadmap', ['g-designers'], 'viewer')
    await spaces.setGroupRole('roadmap', 'g-designers', 'editor')
    expect((await spaces.get('roadmap')).groups).toEqual([
      { id: 'g-designers', name: 'Designers', role: 'editor' }
    ])
    await spaces.unlinkGroup('roadmap', 'g-designers')
    expect((await spaces.get('roadmap')).groups).toEqual([])
  })

  it('refuses a write on a space the caller does not administer', async () => {
    const spaces = memorySpaces([{ ...roadmap, role: 'editor' }], {
      people,
      groups
    })

    await expect(spaces.edit('roadmap', { name: 'Q3' })).rejects.toMatchObject({
      status: 403,
      code: 'not_space_admin'
    })
  })

  it('lists, gets and creates spaces', async () => {
    const spaces = memorySpaces([roadmap], { people, groups })

    const created = await spaces.create({
      name: 'Launch',
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['tasks']
    })

    expect(await spaces.list()).toEqual([
      {
        id: 'roadmap',
        name: 'Roadmap',
        role: 'admin',
        color: null,
        description: '',
        pinnedAt: null,
        openedAt: null,
        manages: true,
        members: [
          {
            id: 'u-alice',
            username: 'alice',
            displayName: null,
            workplaceFqdn: null
          }
        ]
      },
      created
    ])
    expect(await spaces.get(created.id)).toMatchObject({
      name: 'Launch',
      role: 'admin',
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['tasks']
    })
    await expect(spaces.get('nowhere')).rejects.toMatchObject({ status: 404 })
  })

  it('archives, bins, restores and deletes for good, like the backend', async () => {
    const spaces = memorySpaces([roadmap], { people, groups })
    const ids = (list: { id: string }[]) => list.map(space => space.id)

    await spaces.setState('roadmap', 'archived')
    expect(await spaces.list()).toEqual([])
    expect(ids(await spaces.shelved('archived'))).toEqual(['roadmap'])
    await expect(spaces.remove('roadmap')).rejects.toMatchObject({
      status: 409
    })

    await spaces.setState('roadmap', 'trashed')
    expect(ids(await spaces.shelved('trashed'))).toEqual(['roadmap'])
    await spaces.setState('roadmap', 'active')
    expect(ids(await spaces.list())).toEqual(['roadmap'])

    await spaces.setState('roadmap', 'trashed')
    await spaces.emptyBin()
    expect(await spaces.shelved('trashed')).toEqual([])
  })
})

describe('memoryFeed', () => {
  const seed = {
    roadmap: [...Array.from({ length: 12 }, (_, i) => message(i + 1)), file]
  }
  const feedFor = (role: 'admin' | 'viewer') =>
    memoryFeed(seed, {
      me: { id: 'u-bob', name: 'Bob Durand' },
      roles: { roadmap: role },
      pageSize: 10
    })

  it('reads the newest page of a category, then the older one', async () => {
    const feed = feedFor('admin')

    const first = await feed.list('roadmap', { category: 'messages' })
    expect(first.items.map(item => item.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${String(12 - i)}`)
    )

    const older = await feed.list('roadmap', {
      category: 'messages',
      before: first.next ?? ''
    })
    expect(older).toEqual({ items: [message(2), message(1)], next: null })
  })

  it('reads nothing before an item that is gone', async () => {
    expect(await feedFor('admin').list('roadmap', { before: 'gone' })).toEqual({
      items: [],
      next: null
    })
  })

  it('keeps only the cards of a category', async () => {
    expect(
      await feedFor('admin').list('roadmap', { category: 'files' })
    ).toEqual({ items: [file], next: null })
  })

  it("edits, reacts to and deletes the caller's own post", async () => {
    const feed = feedFor('admin')
    const post = await feed.post('roadmap', 'Hi all', [])

    await feed.edit('roadmap', post.id, 'Hello all', [])
    await feed.react('roadmap', post.id, '🎉')

    expect(await feed.item('roadmap', post.id)).toMatchObject({
      body: 'Hello all',
      reactions: [{ key: '🎉', userIds: ['u-bob'] }]
    })

    await feed.unreact('roadmap', post.id, '🎉')
    expect((await feed.item('roadmap', post.id)).reactions).toEqual([])

    await feed.remove('roadmap', post.id)
    await expect(feed.item('roadmap', post.id)).rejects.toMatchObject({
      status: 404
    })
  })

  it('refuses a post from a viewer', async () => {
    await expect(
      feedFor('viewer').post('roadmap', 'Hi', [])
    ).rejects.toMatchObject({ status: 403, code: 'cannot_post' })
  })
})

describe('memoryDirectory', () => {
  const directory = memoryDirectory({ people, groups }, { pageSize: 1 })

  it('searches people by name, username or email, by page', async () => {
    expect(await directory.people('', 1)).toEqual({
      people: [
        {
          username: 'alice',
          email: 'alice@acme.test',
          displayName: 'Alice Martin'
        }
      ],
      hasNextPage: true
    })
    expect((await directory.people('DURAND', 1)).people).toEqual([
      { username: 'bob', email: 'bob@acme.test', displayName: 'Bob Durand' }
    ])
  })

  it('searches groups by name', async () => {
    expect(await directory.groups('design', 1)).toEqual({
      groups,
      hasNextPage: false
    })
  })
})

describe('memoryTokens', () => {
  const empty = { personal: [], organization: [] }
  const digest = {
    id: 'digest',
    name: 'Digest',
    scopes: ['feed:read' as const],
    spaces: 'all' as const,
    role: 'viewer' as const,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-10-01T08:00:00.000Z'
  }
  const options = {
    organizationAdmin: true,
    policy: { allowNoExpiry: false, maxLifetimeDays: 90 },
    spaces: [{ id: 'roadmap', name: 'Roadmap' }]
  }

  it('creates, renames and revokes a token', async () => {
    const tokens = memoryTokens(empty, options)

    const { id, token } = await tokens.create('organization', {
      name: 'Digest',
      scopes: ['feed:read'],
      spaces: 'all',
      role: 'viewer',
      expiresInDays: 7
    })
    expect(token).toMatch(/^tws_/)
    await tokens.rename('organization', id, 'Weekly digest')
    expect(await tokens.list('organization')).toMatchObject([
      { id, name: 'Weekly digest', role: 'viewer' }
    ])

    await tokens.revoke('organization', id)
    expect(await tokens.list('organization')).toEqual([])
    expect(await tokens.list('personal')).toEqual([])
  })

  it('refuses the organization tokens to someone who is not an admin', async () => {
    const tokens = memoryTokens(
      { personal: [], organization: [{ ...digest }] },
      { ...options, organizationAdmin: false }
    )

    await expect(tokens.list('organization')).rejects.toMatchObject({
      status: 403,
      reason: 'not an admin of the organization'
    })
    await expect(
      tokens.revoke('organization', digest.id)
    ).rejects.toMatchObject({ status: 404 })
    await expect(tokens.organizationSpaces()).rejects.toMatchObject({
      status: 403
    })
    await expect(tokens.list('personal')).resolves.toEqual([])
  })

  it('follows the organization policy', async () => {
    const tokens = memoryTokens(empty, options)
    const token = (expiresInDays: 7 | 365 | null) =>
      tokens.create('personal', {
        name: 'CI',
        scopes: ['space:read'],
        spaces: 'all',
        expiresInDays
      })

    await expect(token(365)).rejects.toMatchObject({ status: 400 })
    await expect(token(null)).rejects.toMatchObject({ status: 400 })
    await expect(token(7)).resolves.toMatchObject({ scopes: ['space:read'] })
    await expect(tokens.policy()).resolves.toEqual(options.policy)
  })
})
