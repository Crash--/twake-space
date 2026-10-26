import type { Logger } from 'pino'

const LONG_FAILING_MS = 25 * 60_000

// For a job retried on its own: a warning when it starts failing, then one
// error, so one Sentry event, once it has kept failing for 25 minutes.
export function failureStreak(
  log: Pick<Logger, 'warn' | 'error'>,
  message: string,
  now = Date.now
) {
  let since: number | undefined
  let reported = false
  return {
    failed(fields: object) {
      if (since === undefined) {
        since = now()
        log.warn(fields, message)
      } else if (!reported && now() - since > LONG_FAILING_MS) {
        reported = true
        log.error(fields, `${message} for over 25 minutes`)
      }
    },
    succeeded() {
      since = undefined
      reported = false
    }
  }
}
