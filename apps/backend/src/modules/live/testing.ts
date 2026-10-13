import type { RabbitMQMessageHandler } from '@linagora/rabbitmq-client'
import { pino } from 'pino'
import { listenForLive, type Broker } from './notify.ts'
import type { Streams } from './streams.ts'

// Delivers each live message to every replica listening in this process.
export async function listenInMemory(
  ...replicas: Pick<Streams, 'send' | 'closeSession'>[]
): Promise<void> {
  const consumers: {
    routingKeys: string[]
    handler: RabbitMQMessageHandler
  }[] = []
  const broker: Broker = {
    subscribe(exchange, routingKey, _queue, handler, options) {
      consumers.push({
        routingKeys: [
          routingKey,
          ...(options?.bindings ?? []).map(b => b.routingKey)
        ],
        handler
      })
      return Promise.resolve()
    },
    async publish(exchange, routingKey, message) {
      for (const { routingKeys, handler } of consumers) {
        if (!routingKeys.includes(routingKey)) continue
        await handler(structuredClone(message), {
          exchange,
          routingKey,
          headers: {}
        })
      }
    }
  }
  for (const streams of replicas) {
    await listenForLive(broker, 'live', streams, pino({ level: 'silent' }))
  }
}
