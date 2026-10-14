import { describe, expect, it } from 'vitest'

import { showcaseFeed } from '@/adapters/memory/seed'
import { cardAction, cardApp, type FeedCard } from '@/application/feed'

const NOW = Date.UTC(2026, 9, 8, 12)
const cards = (): FeedCard[] =>
  showcaseFeed(NOW).filter(item => item.kind === 'card')

describe('showcaseFeed', () => {
  it('has a card for every action of every app that sends them', () => {
    const seen = new Set(
      cards().map(card => `${cardApp(card) ?? ''}.${cardAction(card) ?? ''}`)
    )
    expect([...seen].sort()).toEqual(
      [
        'calendar.accepted',
        'calendar.created',
        'calendar.declined',
        'calendar.proposed',
        'calendar.rescheduled',
        'calendar.updated',
        'drive.changed',
        'drive.created',
        'drive.updated',
        'mail.received',
        'mail.sent',
        'tasks.assigned',
        'tasks.completed',
        'tasks.created',
        'tasks.deleted',
        'tasks.moved',
        'tasks.reopened',
        'tasks.restored',
        'tasks.unassigned',
        'tasks.updated'
      ].sort()
    )
  })

  it('has every kind of actor, and posts with and without an edit', () => {
    const items = showcaseFeed(NOW)
    const actors = cards().map(card => card.actor?.type ?? null)
    expect(new Set(actors)).toEqual(
      new Set(['user', 'token', 'deleted_user', null])
    )
    expect(
      cards().some(c => c.actor?.type === 'user' && c.actor.name === null)
    ).toBe(true)
    const posts = items.filter(item => item.kind === 'post')
    expect(posts.some(post => post.editedAt !== null)).toBe(true)
    expect(posts.some(post => post.editedAt === null)).toBe(true)
  })

  it('puts the items a minute apart, ending a minute ago, with unique ids', () => {
    const items = showcaseFeed(NOW)
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
    expect(items.at(-1)?.time).toBe(new Date(NOW - 60_000).toISOString())
    expect(items.every(item => item.time === item.updatedAt)).toBe(true)
  })
})
