import { sql } from 'drizzle-orm'
import type { Tx } from '../../infra/db.ts'

// Every replica consumes the platform queue, so the events of one space take
// turns on these, while other spaces go on. An organization's deletion waits
// for the events of its spaces. Always the organization first, then the space.
export async function lockOrganization(
  tx: Tx,
  organizationId: string,
  mode: 'shared' | 'exclusive'
) {
  const key = `organization:${organizationId}`
  await tx.execute(
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${key}))`
      : sql`select pg_advisory_xact_lock(hashtext(${key}))`
  )
}

export async function lockSpace(
  tx: Tx,
  organizationId: string,
  spaceId: string
) {
  await lockOrganization(tx, organizationId, 'shared')
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`space:${spaceId}`}))`
  )
}
