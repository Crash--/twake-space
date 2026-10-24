export const MEETING_MINUTES = 30

/** Times are ISO 8601 with the offset of `timezone`. */
export interface MeetingRequest {
  title: string
  start: string
  end: string
  timezone: string
  description?: string
  /** The calendar event's UID. Retries reuse it, so the calendar creates one meeting. */
  uid: string
}

/**
 * Editors and admins only. The meeting shows up later, as the feed card of
 * the calendar event with that UID.
 */
export interface MeetingsService {
  schedule: (spaceId: string, request: MeetingRequest) => Promise<void>
}

export const MINUTE = 60_000

const pad = (value: number) => String(value).padStart(2, '0')

// Minutes `zone` is ahead of UTC at `instant`.
function offsetOf(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(item => item.type === type)?.value)
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second')
  )
  return Math.round((wall - instant.getTime()) / MINUTE)
}

// The wall clock of `zone` at `instant`, read with the UTC getters.
function wallClock(instant: Date, zone: string): Date {
  return new Date(instant.getTime() + offsetOf(instant, zone) * MINUTE)
}

/** ISO 8601 with the offset of `zone`, as the calendar expects it. */
export function withOffset(instant: Date, zone: string): string {
  const offset = offsetOf(instant, zone)
  const { date, time } = toInputs(instant, zone)
  const abs = Math.abs(offset)
  return `${date}T${time}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function toInputs(
  instant: Date,
  zone: string
): { date: string; time: string } {
  const wall = wallClock(instant, zone)
  return {
    date: `${String(wall.getUTCFullYear())}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
  }
}

/** The first instant at or after `instant` whose `zone` minutes are a multiple of `step`. */
export function nextSlot(instant: Date, zone: string, step: number): Date {
  const past = wallClock(instant, zone).getTime() % (step * MINUTE)
  return new Date(instant.getTime() + (past && step * MINUTE - past))
}

export function fromInputs(
  date: string,
  time: string,
  zone: string
): Date | null {
  const wall = new Date(`${date}T${time}Z`).getTime()
  if (Number.isNaN(wall)) return null
  // The offset at the guess can differ from the one at the answer near a DST change
  const guess = new Date(wall - offsetOf(new Date(wall), zone) * MINUTE)
  return new Date(wall - offsetOf(guess, zone) * MINUTE)
}
