import { eq, sql } from 'drizzle-orm'
import type { Db, Tx } from '../../infra/db.ts'
import { homeservers, organizations } from './schema.ts'

export interface HomeserverConfig {
  url: string
  serverName: string
  chatUrl?: string | undefined
}

async function writeHomeserver(
  tx: Tx,
  existingId: string | null | undefined,
  homeserver: HomeserverConfig
): Promise<string> {
  const values = {
    url: homeserver.url,
    serverName: homeserver.serverName,
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
// organization to it with chat on: a single installation has no chat control
// plane to tell which organizations have chat.
export function configureHomeserver(
  db: Db,
  homeserver: HomeserverConfig
): Promise<string> {
  return db.transaction(async tx => {
    // Replicas start together.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('homeserver'))`)
    const [existing] = await tx
      .select({ id: homeservers.id })
      .from(homeservers)
      .limit(1)
    const id = await writeHomeserver(tx, existing?.id, homeserver)
    await tx
      .update(organizations)
      .set({ homeserverId: id, chatAvailable: true, updatedAt: sql`now()` })
    return id
  })
}

// In SaaS each tenant has its own homeserver, updated in place.
export async function linkHomeserver(
  tx: Tx,
  organizationId: string,
  homeserver: HomeserverConfig
): Promise<void> {
  const [organization] = await tx
    .select({ homeserverId: organizations.homeserverId })
    .from(organizations)
    .where(eq(organizations.organizationId, organizationId))
    .for('update')
  if (!organization) return
  const id = await writeHomeserver(tx, organization.homeserverId, homeserver)
  await tx
    .update(organizations)
    .set({ homeserverId: id })
    .where(eq(organizations.organizationId, organizationId))
}
