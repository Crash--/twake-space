import { describe, expect, it } from 'vitest'

import { nextSlot, toInputs } from '@/application/meetings'

const slot = (iso: string, zone: string) =>
  toInputs(nextSlot(new Date(iso), zone, 30), zone)

describe('nextSlot', () => {
  it('rounds up to the next half hour of the zone', () => {
    expect(slot('2026-10-24T08:10:20Z', 'Europe/Paris')).toEqual({
      date: '2026-10-24',
      time: '10:30'
    })
    expect(slot('2026-10-24T23:50:00Z', 'UTC')).toEqual({
      date: '2026-10-25',
      time: '00:00'
    })
  })

  it('keeps an instant already on a slot', () => {
    expect(slot('2026-10-24T08:30:00Z', 'UTC').time).toBe('08:30')
  })

  it('follows a zone ahead by quarter hours', () => {
    // Kathmandu is 5:45 ahead: 08:10 UTC is 13:55 there
    expect(slot('2026-10-24T08:10:00Z', 'Asia/Kathmandu').time).toBe('14:00')
  })
})
