import { describe, expect, it, vi } from 'vitest'
import { failureStreak } from './failing.ts'

describe('failureStreak', () => {
  function setup() {
    const log = { warn: vi.fn(), error: vi.fn() }
    let clock = 0
    const streak = failureStreak(log, 'sweep failed', () => clock)
    const at = (minutes: number) => {
      clock = minutes * 60_000
    }
    return { log, streak, at }
  }

  it('warns once, then reports one error after 25 minutes', () => {
    const { log, streak, at } = setup()

    for (const minute of [0, 10, 26, 30, 60]) {
      at(minute)
      streak.failed({ attempt: minute })
    }

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith({ attempt: 0 }, 'sweep failed')
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      { attempt: 26 },
      'sweep failed for over 25 minutes'
    )
  })

  it('starts over after a success', () => {
    const { log, streak, at } = setup()

    at(0)
    streak.failed({})
    at(20)
    streak.succeeded()
    at(30)
    streak.failed({})
    at(50)
    streak.failed({})

    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.error).not.toHaveBeenCalled()
    at(56)
    streak.failed({})
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})
