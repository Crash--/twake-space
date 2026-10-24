import * as Sentry from '@sentry/node'

// Loaded with --import: in ESM, pino and Fastify are only instrumented when
// Sentry is initialised before they are imported. Unset SENTRY_DSN disables it.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  // Sentry collects all of these by default: client IPs (also in forwarding
  // headers), search terms and link-preview URLs in query strings, post
  // bodies, and database query parameters.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false
  },
  integrations: [
    Sentry.pinoIntegration({ error: { levels: ['error', 'fatal'] } }),
    // Sentry's default only warns, where Node would stop the process.
    Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })
  ]
})
