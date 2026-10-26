import { eq, inArray, lt } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Db } from '../../infra/db.ts'
import { failureStreak } from '../../infra/failing.ts'
import { tellRevoked } from '../live/notify.ts'
import { oidcRevokedSessions } from './schema.ts'

export interface AuthStore {
  isRevoked: (sessionId: string) => Promise<boolean>
  revoke: (sessionId: string, until: Date) => Promise<void>
}

export function postgresAuthStore(db: Db): AuthStore {
  return {
    async isRevoked(sessionId) {
      const rows = await db
        .select({ sid: oidcRevokedSessions.sid })
        .from(oidcRevokedSessions)
        .where(eq(oidcRevokedSessions.sid, sessionId))
        .limit(1)
      return rows.length > 0
    },

    async revoke(sessionId, until) {
      await db.transaction(async tx => {
        await tx
          .delete(oidcRevokedSessions)
          .where(lt(oidcRevokedSessions.expiresAt, new Date()))
        await tx
          .insert(oidcRevokedSessions)
          .values({ sid: sessionId, expiresAt: until })
          .onConflictDoNothing()
        // Every replica closes the streams it holds for the session.
        tellRevoked(tx, sessionId)
      })
    }
  }
}

const SWEEP_EVERY_MS = 60_000

// A replica misses a revocation sent while it was disconnected from RabbitMQ,
// or by a replica of another version.
export function scheduleRevocationSweep(
  db: Db,
  streams: { sessions: () => string[]; closeSession: (id: string) => void },
  logger: Logger
): () => void {
  const sweep = async () => {
    const open = streams.sessions()
    if (open.length === 0) return
    const revoked = await db
      .select({ sid: oidcRevokedSessions.sid })
      .from(oidcRevokedSessions)
      .where(inArray(oidcRevokedSessions.sid, open))
    for (const { sid } of revoked) streams.closeSession(sid)
  }
  const sweeps = failureStreak(logger, 'revocation sweep failed')
  const timer = setInterval(() => {
    sweep().then(
      () => {
        sweeps.succeeded()
      },
      (error: unknown) => {
        sweeps.failed({ err: error })
      }
    )
  }, SWEEP_EVERY_MS)
  return () => {
    clearInterval(timer)
  }
}
