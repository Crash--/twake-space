import Fastify, { LogController, type FastifyRequest } from 'fastify'
import type { Logger } from 'pino'

export function createServer(deps: {
  logger: Logger
  isReady: () => Promise<boolean>
  isAlive?: () => boolean
}) {
  const app = Fastify({
    loggerInstance: deps.logger.child(
      {},
      {
        serializers: {
          req: (request: FastifyRequest) => ({
            method: request.method,
            url: request.url,
            host: request.host,
            remoteAddress: request.ip
          })
        }
      }
    ),
    logController: new LogController({
      disableRequestLogging: request => request.url.startsWith('/health/')
    })
  })

  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500
    if (status < 500) return reply.send(error)
    request.log.error({ err: error }, 'request failed')
    return reply.code(500).send({ error: 'internal' })
  })

  app.get('/health/live', (_request, reply) => {
    const alive = deps.isAlive?.() ?? true
    return reply
      .code(alive ? 200 : 503)
      .send({ status: alive ? 'ok' : 'unavailable' })
  })

  app.get('/health/ready', async (_request, reply) => {
    const ready = await deps.isReady().catch(() => false)
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'unavailable' })
  })

  return app
}

export type HttpServer = ReturnType<typeof createServer>
