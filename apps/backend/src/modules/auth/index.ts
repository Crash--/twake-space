import type { Db } from '../../infra/db.ts'
import type { HttpServer } from '../../infra/http.ts'
import type { Directory } from '../../infra/ldap-rest.ts'
import { apiTokenAuthenticator } from '../tokens/authenticator.ts'
import { createAuthenticator } from './authenticator.ts'
import { discoverIdentityProvider, type OidcOptions } from './oidc.ts'
import { registerAuth, type Authorize } from './routes.ts'
import { postgresAuthStore } from './store.ts'

export { fixedWindows, perHour, perMinute } from './limits.ts'
export type { Identity } from './oidc.ts'
export type { Authorize, Caller } from './routes.ts'
export { scheduleRevocationSweep } from './store.ts'

export async function setUpAuth(
  app: HttpServer,
  deps: { db: Db; oidc: OidcOptions; directory: Directory }
): Promise<Authorize> {
  const provider = await discoverIdentityProvider(deps.oidc)
  const store = postgresAuthStore(deps.db)
  return registerAuth(app, {
    provider,
    store,
    authenticate: createAuthenticator({ provider, store }),
    authenticateToken: apiTokenAuthenticator(deps.db, deps.directory)
  })
}
