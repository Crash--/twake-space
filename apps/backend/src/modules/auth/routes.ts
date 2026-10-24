import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { HttpServer } from '../../infra/http.ts'
import {
  API_TOKEN_PREFIX,
  type Scope,
  type TokenCaller
} from '../tokens/authenticator.ts'
import { GateFullError, type Authenticate } from './authenticator.ts'
import { DEFAULT_LIMIT, fixedWindows, type Limiter } from './limits.ts'
import type { Identity, IdentityProvider } from './oidc.ts'
import type { AuthStore } from './store.ts'

export type SessionCaller = Identity & {
  kind: 'session'
  organizationId: string
}
export type Caller = SessionCaller | TokenCaller

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null
  }
}

// Longer than any access token issued in the revoked session can live.
const REVOCATION_TTL_MS = 24 * 60 * 60 * 1000

const logoutBody = z.object({ logout_token: z.string().min(1) })

function unauthorized(reply: FastifyReply, error: string | null) {
  return reply
    .code(401)
    .header('www-authenticate', error ? `Bearer error="${error}"` : 'Bearer')
    .send({ error: 'unauthorized' })
}

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<FastifyReply | undefined>

// With a scope, API tokens holding it are let in too, and every token with
// 'any'; without, only sessions.
export type Authorize = (scope?: Scope | 'any') => PreHandler

export function registerAuth(
  app: HttpServer,
  deps: {
    authenticate: Authenticate
    authenticateToken: (token: string) => Promise<TokenCaller | null>
    provider: IdentityProvider
    store: AuthStore
    limiter?: Limiter
  }
): Authorize {
  const limiter = deps.limiter ?? fixedWindows()
  app.decorateRequest('caller', null)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    }
  )

  const authorize: Authorize = scope => async (request, reply) => {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? []
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return unauthorized(reply, null)
    }

    let identity: Identity | TokenCaller | null
    try {
      identity = token.startsWith(API_TOKEN_PREFIX)
        ? await deps.authenticateToken(token)
        : await deps.authenticate(token)
    } catch (error) {
      // A full gate means a flood of made-up tokens: not one error report each.
      if (error instanceof GateFullError) {
        request.log.warn('too many new tokens waiting for a check')
      } else request.log.error({ err: error }, 'access token check failed')
      return reply.code(503).send({ error: 'unavailable' })
    }
    if (!identity) return unauthorized(reply, 'invalid_token')

    if ('kind' in identity) {
      if (!scope || (scope !== 'any' && !identity.scopes.includes(scope))) {
        return reply
          .code(403)
          .header(
            'www-authenticate',
            `Bearer error="insufficient_scope"${scope ? `, scope="${scope}"` : ''}`
          )
          .send({ error: 'insufficient_scope' })
      }
      request.caller = identity
    } else {
      const { organizationId } = identity
      if (!organizationId) return reply.code(403).send({ error: 'forbidden' })
      request.caller = { ...identity, kind: 'session', organizationId }
    }

    const caller = request.caller
    const who =
      caller.kind === 'session'
        ? `user:${caller.userId}`
        : `token:${caller.tokenId}`
    const { config, method, url } = request.routeOptions
    const key = config.limit ? `${who} ${String(method)} ${String(url)}` : who
    const waitMs = await limiter(key, config.limit ?? DEFAULT_LIMIT)
    if (waitMs === 0) return
    request.log.warn({ caller: who, route: url }, 'rate limited')
    return reply
      .code(429)
      .header('retry-after', Math.ceil(waitMs / 1000))
      .send({ error: 'rate_limited' })
  }

  app.post('/auth/backchannel-logout', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const body = logoutBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' })
    let sessionId: string
    try {
      sessionId = await deps.provider.verifyLogoutToken(body.data.logout_token)
    } catch (error) {
      request.log.warn({ err: error }, 'logout token refused')
      return reply.code(400).send({ error: 'invalid_request' })
    }
    await deps.store.revoke(sessionId, new Date(Date.now() + REVOCATION_TTL_MS))
    return reply.code(200).send()
  })

  return authorize
}
