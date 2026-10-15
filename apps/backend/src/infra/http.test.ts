import { pino } from 'pino'
import { expect, it } from 'vitest'
import { createServer } from './http.ts'

function capturedLogs() {
  const lines: Record<string, unknown>[] = []
  const logger = pino(
    { level: 'info' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  )
  return { lines, logger }
}

it('answers a bare 500 and logs the error behind it', async () => {
  const { lines, logger } = capturedLogs()
  const app = createServer({ logger, isReady: () => Promise.resolve(true) })
  app.get('/boom', () => {
    throw new Error('connect ECONNREFUSED 10.0.0.7:5432')
  })

  const response = await app.inject({ method: 'GET', url: '/boom' })

  expect(response.statusCode).toBe(500)
  expect(response.json()).toEqual({ error: 'internal' })
  expect(JSON.stringify(lines)).toContain('ECONNREFUSED 10.0.0.7')
})

it('keeps the answer of an error made for the client', async () => {
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  app.post('/echo', () => 'ok')

  const response = await app.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{'
  })

  expect(response.statusCode).toBe(400)
})

it('answers 503 on liveness once the process is no longer alive', async () => {
  let alive = true
  const app = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true),
    isAlive: () => alive
  })
  const live = () => app.inject({ method: 'GET', url: '/health/live' })

  expect((await live()).statusCode).toBe(200)
  alive = false
  expect((await live()).statusCode).toBe(503)
})
