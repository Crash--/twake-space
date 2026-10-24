import { and, eq } from 'drizzle-orm'
import { fresh } from '../../events/freshness.ts'
import type { Db } from '../../infra/db.ts'
import type { Directory, OrganizationRole } from '../../infra/ldap-rest.ts'
import { organizationMembers } from './schema.ts'

// Read from ldap-rest every time: the copy only hears of a promotion, a
// demotion or a departure through the platform's events, and a lost or forged
// one would leave the wrong person in charge. The answer refreshes the copy,
// and is newer than any event already sent about it.
export async function liveOrganizationRole(
  db: Db,
  directory: Pick<Directory, 'organizationRole'>,
  { organizationId, userId }: { organizationId: string; userId: string | null }
): Promise<OrganizationRole | undefined> {
  if (userId === null) return undefined
  const live = await directory.organizationRole(organizationId, userId)
  await db.transaction(async tx => {
    await fresh(tx, new Date(), [
      `organization:${organizationId}:member:${userId}`
    ])
    // Not deleted: ldap-rest also answers nothing for a role this service
    // does not know, and the row still maps the person's email. The departure
    // event removes it.
    if (!live) {
      await tx
        .update(organizationMembers)
        .set({ role: 'member' })
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId)
          )
        )
      return
    }
    await tx
      .insert(organizationMembers)
      .values({ organizationId, userId, ...live })
      .onConflictDoUpdate({
        target: [
          organizationMembers.organizationId,
          organizationMembers.userId
        ],
        set: live
      })
  })
  return live?.role
}
