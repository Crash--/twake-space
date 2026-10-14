import { describe, expect, it } from 'vitest'

import {
  cardAction,
  cardApp,
  fileExtension,
  toEventState,
  toFeedChange,
  withReaction,
  type FeedCard
} from '@/application/feed'

const card: FeedCard = {
  id: 'c1',
  kind: 'card',
  category: 'activities',
  time: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  reactions: [],
  type: 'com.twake.tasks.task.moved.v1',
  actor: { type: 'user', id: 'u1', name: 'Bob' },
  object: {
    type: 'task',
    id: 'T-1',
    title: 'Write the brief',
    container: { kind: 'project', id: 'p1' }
  },
  preview: null,
  state: {},
  files: null
}

describe('withReaction', () => {
  const reacted = {
    ...card,
    reactions: [
      { key: '👍', userIds: ['u1'] },
      { key: '🎉', userIds: ['u1', 'me'] }
    ]
  }

  it('adds mine last, and a new key last', () => {
    expect(withReaction(reacted, '👍', 'me', true).reactions).toEqual([
      { key: '👍', userIds: ['u1', 'me'] },
      { key: '🎉', userIds: ['u1', 'me'] }
    ])
    expect(withReaction(card, '👀', 'me', true).reactions).toEqual([
      { key: '👀', userIds: ['me'] }
    ])
  })

  it('takes mine back, and the key with it when no one is left', () => {
    expect(withReaction(reacted, '🎉', 'me', false).reactions).toEqual([
      { key: '👍', userIds: ['u1'] },
      { key: '🎉', userIds: ['u1'] }
    ])
    expect(
      withReaction(withReaction(card, '👀', 'me', true), '👀', 'me', false)
        .reactions
    ).toEqual([])
  })

  it('changes nothing when mine is already there', () => {
    expect(withReaction(reacted, '🎉', 'me', true)).toEqual(reacted)
  })
})

describe('toFeedChange', () => {
  it('reads a feed live event', () => {
    expect(
      toFeedChange({ spaceId: 'a1', itemId: 'c1', change: 'removed' })
    ).toEqual({ spaceId: 'a1', itemId: 'c1', change: 'removed' })
  })

  it('ignores one it cannot read', () => {
    expect(toFeedChange({ spaceId: 'a1', itemId: 'c1' })).toBeNull()
    expect(toFeedChange({ spaceId: 'a1', change: 'added' })).toBeNull()
    expect(toFeedChange(null)).toBeNull()
  })
})

describe('cards', () => {
  it('read their app and their latest action from the event type', () => {
    expect(cardApp(card)).toBe('tasks')
    expect(cardAction(card)).toBe('moved')
  })

  it('leave both unknown on a type they cannot read', () => {
    const other = { ...card, type: 'other' }
    expect(cardApp(other)).toBeNull()
    expect(cardAction(other)).toBeNull()
  })
})

describe('toEventState', () => {
  it("reads a calendar card's times, place, answers and Meet room", () => {
    expect(
      toEventState({
        start: '2026-10-08T09:00:00Z',
        end: '2026-10-08T10:00:00Z',
        allDay: false,
        location: 'Room 4',
        previous: {
          start: '2026-10-08T08:00:00Z',
          end: '2026-10-08T09:00:00Z'
        },
        rsvp: { accepted: 2, declined: 1 },
        meeting: { room: 'abc-defg-hij' }
      })
    ).toEqual({
      start: '2026-10-08T09:00:00Z',
      end: '2026-10-08T10:00:00Z',
      allDay: false,
      location: 'Room 4',
      previous: { start: '2026-10-08T08:00:00Z', end: '2026-10-08T09:00:00Z' },
      proposed: null,
      rsvp: { accepted: 2, declined: 1, tentative: 0, pending: 0 },
      room: 'abc-defg-hij'
    })
  })

  it('reads a proposed new time with who proposed it', () => {
    expect(
      toEventState({
        start: '2026-10-08',
        end: '2026-10-09',
        allDay: true,
        proposed: {
          start: '2026-10-10',
          end: '2026-10-11',
          by: 'carol@acme.test'
        }
      })
    ).toMatchObject({
      allDay: true,
      proposed: {
        start: '2026-10-10',
        end: '2026-10-11',
        by: 'carol@acme.test'
      }
    })
  })

  it('has nothing to show without times', () => {
    expect(toEventState({})).toBeNull()
  })
})

describe('fileExtension', () => {
  it('reads the upper-case extension of a file name', () => {
    expect(fileExtension('Budget 2027.xlsx')).toBe('XLSX')
    expect(fileExtension('archive.tar.gz')).toBe('GZ')
  })

  it('reads none from a name without one, or a hidden file', () => {
    expect(fileExtension('README')).toBe(null)
    expect(fileExtension('.env')).toBe(null)
    expect(fileExtension('Q4: plan. Final version')).toBe(null)
  })
})
