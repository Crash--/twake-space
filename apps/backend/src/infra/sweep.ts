// One pass at a time: a nudge during a pass runs another once it ends.
export function scheduleSweep(
  pass: (stopped: () => boolean) => Promise<void>,
  everyMs: number,
  failed: (error: unknown) => void
): { nudge: () => void; stop: () => Promise<void> } {
  let running: Promise<void> | undefined
  let again = false
  let stopped = false
  const nudge = () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = pass(() => stopped)
      .catch(failed)
      .finally(() => {
        running = undefined
        if (again) {
          again = false
          nudge()
        }
      })
  }
  nudge()
  const timer = setInterval(nudge, everyMs)
  return {
    nudge,
    async stop() {
      stopped = true
      clearInterval(timer)
      again = false
      await running
    }
  }
}
