import { readFileSync } from 'node:fs'
import { initSentry } from '@linagora/twake-node-telemetry/sentry'

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

// Loaded with --import, so Sentry can instrument the modules main.ts loads
// (http, Fastify, postgres). Unset SENTRY_DSN disables it.
initSentry({ service: 'twake-space-backend', version })
