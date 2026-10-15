import { describe, expect, it } from 'vitest'

import {
  badgeLabel,
  emptySnapshots,
  hasCounts,
  replaceSnapshot,
  resetSnapshot,
  spaceCount,
  spaceTotal,
  tabCount
} from '@/application/badges'
import type { Space } from '@/application/spaces'

const space: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'editor',
  createdAt: '2026-01-01T00:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: ['chat', 'tasks', 'drive', 'mail', 'calendar'],
  chat: true,
  mail: true,
  homeserverUrl: 'https://matrix.acme.test',
  chatUrl: null,
  banner: null,
  members: [],
  groups: [],
  resources: [
    { kind: 'matrix_space', id: '!s:acme' },
    { kind: 'project', id: 'p1' },
    { kind: 'drive', id: null },
    { kind: 'mailbox', id: 'roadmap@acme' },
    { kind: 'calendar', id: 'cal-1' }
  ]
}

describe('replaceSnapshot', () => {
  it('keeps the counts by resource, for every space', () => {
    const next = replaceSnapshot(emptySnapshots(), 'mail', [
      { resourceId: 'roadmap@acme', count: 3 },
      { resourceId: 'other@acme', count: 5 }
    ])
    expect(next.mail.get('roadmap@acme')).toBe(3)
    expect(next.mail.get('other@acme')).toBe(5)
    expect(next.tasks.size).toBe(0)
  })

  it('replaces the previous snapshot of the app, not the others', () => {
    let snapshots = replaceSnapshot(emptySnapshots(), 'mail', [
      { resourceId: 'roadmap@acme', count: 3 }
    ])
    snapshots = replaceSnapshot(snapshots, 'tasks', [
      { resourceId: 'p1', count: 2 }
    ])
    snapshots = replaceSnapshot(snapshots, 'mail', [
      { resourceId: 'other@acme', count: 1 }
    ])
    expect(snapshots.mail.has('roadmap@acme')).toBe(false)
    expect(snapshots.mail.get('other@acme')).toBe(1)
    expect(snapshots.tasks.get('p1')).toBe(2)
  })

  it('does not change the snapshots it was given', () => {
    const before = emptySnapshots()
    replaceSnapshot(before, 'mail', [{ resourceId: 'm', count: 1 }])
    expect(before.mail.size).toBe(0)
  })
})

describe('resetSnapshot', () => {
  it("forgets one app's counts", () => {
    const snapshots = replaceSnapshot(
      replaceSnapshot(emptySnapshots(), 'mail', [
        { resourceId: 'm', count: 1 }
      ]),
      'tasks',
      [{ resourceId: 'p1', count: 2 }]
    )
    const next = resetSnapshot(snapshots, 'mail')
    expect(next.mail.size).toBe(0)
    expect(next.tasks.get('p1')).toBe(2)
  })

  it('returns the same snapshots when there is nothing to forget', () => {
    const snapshots = emptySnapshots()
    expect(resetSnapshot(snapshots, 'mail')).toBe(snapshots)
  })
})

describe('hasCounts', () => {
  it('tells whether any app reported', () => {
    expect(hasCounts(emptySnapshots())).toBe(false)
    expect(
      hasCounts(
        replaceSnapshot(emptySnapshots(), 'chat', [
          { resourceId: 'x', count: 0 }
        ])
      )
    ).toBe(true)
  })
})

describe('spaceCount', () => {
  it("reads the count of the space's own resource for the app", () => {
    const snapshots = replaceSnapshot(emptySnapshots(), 'mail', [
      { resourceId: 'roadmap@acme', count: 3 },
      { resourceId: 'p1', count: 9 }
    ])
    expect(spaceCount(snapshots, space, 'mail')).toBe(3)
  })

  it('is null for a resource the app did not report, or one not ready', () => {
    const snapshots = replaceSnapshot(emptySnapshots(), 'drive', [
      { resourceId: 'x', count: 4 }
    ])
    expect(spaceCount(snapshots, space, 'tasks')).toBeNull()
    expect(spaceCount(snapshots, space, 'drive')).toBeNull()
  })
})

describe('tabCount', () => {
  it('counts only ready tabs', () => {
    const snapshots = replaceSnapshot(emptySnapshots(), 'chat', [
      { resourceId: '!s:acme', count: 4 }
    ])
    expect(tabCount(snapshots, space, 'chat')).toBe(4)
    expect(tabCount(snapshots, { ...space, chat: false }, 'chat')).toBe(0)
    expect(tabCount(snapshots, { ...space, homeserverUrl: null }, 'chat')).toBe(
      0
    )
  })

  it('is 0 without a count', () => {
    expect(tabCount(emptySnapshots(), space, 'mail')).toBe(0)
  })
})

describe('spaceTotal', () => {
  it('adds up the counts of the space across the apps', () => {
    let snapshots = replaceSnapshot(emptySnapshots(), 'mail', [
      { resourceId: 'roadmap@acme', count: 3 },
      { resourceId: 'other@acme', count: 40 }
    ])
    snapshots = replaceSnapshot(snapshots, 'tasks', [
      { resourceId: 'p1', count: 2 },
      { resourceId: 'p2', count: 7 }
    ])
    snapshots = replaceSnapshot(snapshots, 'chat', [
      { resourceId: '!s:acme', count: 0 }
    ])
    expect(spaceTotal(snapshots, space)).toBe(5)
  })

  it('is 0 when no app reported for the space', () => {
    expect(spaceTotal(emptySnapshots(), space)).toBe(0)
  })
})

describe('badgeLabel', () => {
  it('shows nothing at 0', () => {
    expect(badgeLabel(0)).toBeNull()
  })

  it('shows the count up to 99, then 99+', () => {
    expect(badgeLabel(1)).toBe('1')
    expect(badgeLabel(99)).toBe('99')
    expect(badgeLabel(100)).toBe('99+')
    expect(badgeLabel(1_000_000)).toBe('99+')
  })
})
