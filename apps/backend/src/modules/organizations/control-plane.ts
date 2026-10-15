import { z } from 'zod'
import type { HomeserverConfig } from './homeservers.ts'

const TIMEOUT_MS = 10_000

export interface TenantHomeservers {
  // Undefined while the tenant has no chat deployed.
  homeserverOf(organizationId: string): Promise<HomeserverConfig | undefined>
}

const tenant = z.object({
  homeserverUrl: z.url({ protocol: /^https?$/ }),
  serverName: z.string().min(1),
  // Absent while the tenant has no TwakeSpace chat of its own. A bad one
  // must not cost the tenant its homeserver.
  chatUrl: z
    .url({ protocol: /^https?$/ })
    .optional()
    .catch(undefined)
})

export function controlPlaneHomeservers(controlPlane: {
  url: string
  token: string
}): TenantHomeservers {
  return {
    async homeserverOf(organizationId) {
      const response = await fetch(
        new URL(
          `deployment/${encodeURIComponent(organizationId)}/twake-space`,
          controlPlane.url.endsWith('/')
            ? controlPlane.url
            : `${controlPlane.url}/`
        ),
        {
          headers: { authorization: `Bearer ${controlPlane.token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS)
        }
      )
      if (response.status === 404) return undefined
      if (!response.ok) {
        throw new Error(
          `chat control plane answered ${String(response.status)}`
        )
      }
      const { homeserverUrl, ...rest } = tenant.parse(await response.json())
      return { url: homeserverUrl, ...rest }
    }
  }
}
