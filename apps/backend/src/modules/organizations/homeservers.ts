import { eq, sql } from 'drizzle-orm'
import type { Db, Tx } from '../../infra/db.ts'
import { encrypt, hashSecret } from '../../infra/secrets.ts'
import { homeservers, organizations } from './schema.ts'

export interface HomeserverConfig {
  url: string
  serverName: string
  asToken: string
  hsToken: string
  chatUrl?: string | undefined
}

async function writeHomeserver(
  tx: Tx,
  key: Buffer,
  existingId: string | null | undefined,
  homeserver: HomeserverConfig
): Promise<string> {
  const values = {
    url: homeserver.url,
    serverName: homeserver.serverName,
    asToken: encrypt(key, homeserver.asToken),
    hsToken: encrypt(key, homeserver.hsToken),
    hsTokenHash: hashSecret(homeserver.hsToken),
    chatUrl: homeserver.chatUrl ?? null,
    updatedAt: sql`now()`
  }
  const [row] = existingId
    ? await tx
        .update(homeservers)
        .set(values)
        .where(eq(homeservers.id, existingId))
        .returning({ id: homeservers.id })
    : await tx
        .insert(homeservers)
        .values(values)
        .returning({ id: homeservers.id })
  if (!row) throw new Error('homeserver write returned no row')
  return row.id
}

// Updates the one homeserver in place, whatever changed, and points every
// organization to it, so organizations met before the setting post too.
export function configureHomeserver(
  db: Db,
  key: Buffer,
  homeserver: HomeserverConfig
): Promise<string> {
  return db.transaction(async tx => {
    // Replicas start together.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('homeserver'))`)
    const [existing] = await tx
      .select({ id: homeservers.id })
      .from(homeservers)
      .limit(1)
    const id = await writeHomeserver(tx, key, existing?.id, homeserver)
    await tx.update(organizations).set({ homeserverId: id })
    return id
  })
}

// In SaaS each tenant has its own homeserver, updated in place.
export async function linkHomeserver(
  tx: Tx,
  key: Buffer,
  organizationId: string,
  homeserver: HomeserverConfig
): Promise<void> {
  const [organization] = await tx
    .select({ homeserverId: organizations.homeserverId })
    .from(organizations)
    .where(eq(organizations.organizationId, organizationId))
    .for('update')
  if (!organization) return
  const id = await writeHomeserver(
    tx,
    key,
    organization.homeserverId,
    homeserver
  )
  await tx
    .update(organizations)
    .set({ homeserverId: id })
    .where(eq(organizations.organizationId, organizationId))
}
