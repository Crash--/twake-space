// A stand-in for LemonLDAP: just enough OpenID Connect to sign the seeded
// people in through the browser and for the backend to check their tokens.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { createServer } from 'node:https'

const ISSUER = process.env.ISSUER ?? 'https://oidc:8443'
const BACKEND = { id: 'twakespace-backend', secret: 'qa-backend-secret' }
const AUDIENCE = 'twakespace'
const TOKEN_TTL_S = 3600
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self'"

interface Person {
  uuid: string
  name: string
  email: string
  org_id: string
  org_role: string
}
// Written by start.sh once ldap-rest has given the seeded people their uuid
function people(): Record<string, Person> {
  try {
    return JSON.parse(readFileSync('/people.json', 'utf8')) as Record<
      string,
      Person
    >
  } catch {
    return {}
  }
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048
})
const KID = randomUUID()

interface Grant {
  username: string
  sid: string
  clientId: string
  redirectUri: string
  challenge: string
  nonce: string | null
}
const codes = new Map<string, Grant>()
const accessTokens = new Map<string, Grant & { exp: number }>()
const sessions = new Map<string, string>()

const b64url = (data: Buffer | string) =>
  Buffer.from(data).toString('base64url')

function jwt(claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
  const body = b64url(JSON.stringify(claims))
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${body}`)
    .sign(privateKey)
  return `${header}.${body}.${b64url(signature)}`
}

function userinfo(grant: Grant) {
  const person = people()[grant.username]
  if (!person) return null
  return {
    sub: person.email,
    sid: grant.sid,
    uuid: person.uuid,
    email: person.email,
    name: person.name,
    org_id: person.org_id,
    org_role: person.org_role
  }
}

function liveToken(accessToken: string) {
  const token = accessTokens.get(accessToken)
  return token && token.exp > Date.now() / 1000 && sessions.has(token.sid)
    ? token
    : undefined
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type'
  })
  return res.end(JSON.stringify(body))
}

function redirect(
  res: ServerResponse,
  to: URL,
  headers: Record<string, string> = {}
) {
  res.writeHead(302, { location: to.href, ...headers })
  return res.end()
}

// LemonLDAP answers /authorize with a page, which the browser shows only in
// the frames its frame-ancestors lists; a bare 302 would never be checked.
function portalRedirect(
  res: ServerResponse,
  to: URL,
  headers: Record<string, string> = {}
) {
  res.writeHead(200, {
    'content-type': 'text/html',
    'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS}`,
    ...headers
  })
  const target = to.href.replace(/"/g, '&quot;')
  return res.end(
    `<!doctype html><meta http-equiv="refresh" content="0;url=${target}">`
  )
}

function cookieSession(header: string | undefined) {
  const sid = /(?:^|;\s*)qa_sid=([^;]+)/.exec(header ?? '')?.[1]
  const username = sid ? sessions.get(sid) : undefined
  return sid && username ? { sid, username } : null
}

function issueCode(
  res: ServerResponse,
  query: URLSearchParams,
  sid: string,
  username: string
) {
  const code = b64url(randomBytes(24))
  const redirectUri = query.get('redirect_uri') ?? ''
  codes.set(code, {
    username,
    sid,
    clientId: query.get('client_id') ?? '',
    redirectUri,
    challenge: query.get('code_challenge') ?? '',
    nonce: query.get('nonce')
  })
  const back = new URL(redirectUri)
  back.searchParams.set('code', code)
  const state = query.get('state')
  if (state) back.searchParams.set('state', state)
  back.searchParams.set('iss', ISSUER)
  return portalRedirect(res, back, {
    'set-cookie': `qa_sid=${sid}; Path=/; Secure; HttpOnly; SameSite=None`
  })
}

function loginPage(query: URLSearchParams) {
  const buttons = Object.keys(people())
    .map(
      username =>
        `<button name="username" value="${username}">Sign in as ${username}</button>`
    )
    .join('')
  const hidden = [...query]
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`
    )
    .join('')
  return `<!doctype html><title>Mock SSO</title><form method="post" action="/authorize">${hidden}${buttons}</form>`
}

async function readForm(req: NodeJS.ReadableStream) {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return new URLSearchParams(body)
}

function basicAuth(header: string | undefined) {
  const [id, secret] = Buffer.from(
    (header ?? '').replace(/^Basic /, ''),
    'base64'
  )
    .toString()
    .split(':')
  return { id, secret }
}

const server = createServer(
  {
    key: readFileSync(process.env.TLS_KEY ?? '/certs/oidc.key'),
    cert: readFileSync(process.env.TLS_CERT ?? '/certs/oidc.crt')
  },
  (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', ISSUER)
      if (req.method === 'OPTIONS') {
        json(res, 204, null)
        return
      }

      switch (url.pathname) {
        case '/.well-known/openid-configuration': {
          json(res, 200, {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            userinfo_endpoint: `${ISSUER}/userinfo`,
            introspection_endpoint: `${ISSUER}/introspect`,
            end_session_endpoint: `${ISSUER}/logout`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: [
              'none',
              'client_secret_basic'
            ]
          })
          return
        }

        case '/jwks': {
          json(res, 200, {
            keys: [
              {
                ...publicKey.export({ format: 'jwk' }),
                kid: KID,
                alg: 'RS256',
                use: 'sig'
              }
            ]
          })
          return
        }

        case '/authorize': {
          const query =
            req.method === 'POST' ? await readForm(req) : url.searchParams
          const username = query.get('username')
          if (username && username in people()) {
            const sid = randomUUID()
            sessions.set(sid, username)
            query.delete('username')
            issueCode(res, query, sid, username)
            return
          }
          const session = cookieSession(req.headers.cookie)
          if (session) {
            issueCode(res, query, session.sid, session.username)
            return
          }
          if (query.get('prompt') === 'none') {
            const back = new URL(query.get('redirect_uri') ?? '')
            back.searchParams.set('error', 'login_required')
            const state = query.get('state')
            if (state) back.searchParams.set('state', state)
            portalRedirect(res, back)
            return
          }
          res.writeHead(200, {
            'content-type': 'text/html',
            'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS}`
          })
          return res.end(loginPage(query))
        }

        case '/token': {
          const form = await readForm(req)
          const grant = codes.get(form.get('code') ?? '')
          codes.delete(form.get('code') ?? '')
          const verifier = form.get('code_verifier') ?? ''
          const info = grant && userinfo(grant)
          if (
            !grant ||
            !info ||
            grant.redirectUri !== form.get('redirect_uri') ||
            b64url(createHash('sha256').update(verifier).digest()) !==
              grant.challenge
          ) {
            json(res, 400, { error: 'invalid_grant' })
            return
          }
          const now = Math.floor(Date.now() / 1000)
          const accessToken = b64url(randomBytes(32))
          accessTokens.set(accessToken, { ...grant, exp: now + TOKEN_TTL_S })
          json(res, 200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: TOKEN_TTL_S,
            id_token: jwt({
              iss: ISSUER,
              aud: grant.clientId,
              sub: info.sub,
              sid: grant.sid,
              iat: now,
              exp: now + TOKEN_TTL_S,
              ...(grant.nonce ? { nonce: grant.nonce } : {})
            })
          })
          return
        }

        case '/userinfo': {
          const token = liveToken(
            (req.headers.authorization ?? '').replace(/^Bearer /, '')
          )
          const info = token && userinfo(token)
          if (!info) {
            json(res, 401, { error: 'invalid_token' })
            return
          }
          json(res, 200, info)
          return
        }

        case '/introspect': {
          const client = basicAuth(req.headers.authorization)
          if (client.id !== BACKEND.id || client.secret !== BACKEND.secret) {
            json(res, 401, { error: 'invalid_client' })
            return
          }
          const form = await readForm(req)
          const token = liveToken(form.get('token') ?? '')
          const info = token && userinfo(token)
          if (!token || !info) {
            json(res, 200, { active: false })
            return
          }
          json(res, 200, {
            active: true,
            sub: info.sub,
            aud: AUDIENCE,
            client_id: token.clientId,
            exp: token.exp
          })
          return
        }

        case '/logout': {
          const session = cookieSession(req.headers.cookie)
          if (session) sessions.delete(session.sid)
          const back = url.searchParams.get('post_logout_redirect_uri')
          if (back) {
            redirect(res, new URL(back), {
              'set-cookie': 'qa_sid=; Path=/; Max-Age=0'
            })
            return
          }
          res.writeHead(200)
          return res.end('Signed out')
        }

        default: {
          json(res, 404, { error: 'not_found' })
          return
        }
      }
    })().catch((error: unknown) => {
      console.error(error)
      json(res, 500, { error: 'server_error' })
    })
  }
)

server.listen(Number(process.env.PORT ?? 8443), () => {
  console.log(`mock OIDC provider at ${ISSUER}`)
})
