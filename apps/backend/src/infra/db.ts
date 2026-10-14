import { fileURLToPath } from 'node:url'
import { timestamp } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true })

function connect(url: string) {
  const sql = postgres(url, { onnotice: () => undefined })
  return { sql, db: drizzle({ client: sql }) }
}

export type Db = ReturnType<typeof connect>['db']
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Transaction = Db['transaction']

const commitHooks = new WeakMap<Tx, (() => void)[]>()

type Finishing = Map<
  symbol,
  { value: unknown; finish: (tx: Tx, value: unknown) => Promise<void> }
>
const finishing = new WeakMap<Tx, Finishing>()

// Drizzle has no commit hook. A savepoint hands its hooks to its transaction
// once it is released, so one that rolls back alone drops them.
function runHooksOnCommit(
  target: { transaction: Transaction },
  outer?: { hooks: (() => void)[]; finishing: Finishing }
) {
  const transaction = target.transaction.bind(target)
  target.transaction = (async (
    body: (tx: Tx) => Promise<unknown>,
    config?: Parameters<Transaction>[1]
  ) => {
    const hooks: (() => void)[] = []
    const result = await transaction(async tx => {
      const finishes: Finishing = outer?.finishing ?? (new Map() as Finishing)
      commitHooks.set(tx, hooks)
      finishing.set(tx, finishes)
      runHooksOnCommit(tx, { hooks, finishing: finishes })
      const result = await body(tx)
      if (!outer) {
        for (const { value, finish } of finishes.values()) {
          await finish(tx, value)
        }
      }
      return result
    }, config)
    if (outer) outer.hooks.push(...hooks)
    else for (const hook of hooks) hook()
    return result
  }) as Transaction
}

export function createDb(url: string) {
  const { sql, db } = connect(url)
  runHooksOnCommit(db)
  return { sql, db }
}

/** Runs `hook` once the transaction commits, and never if it rolls back. */
export function afterCommit(tx: Tx, hook: () => void): void {
  const hooks = commitHooks.get(tx)
  if (!hooks) throw new Error('not in a transaction')
  hooks.push(hook)
}

/**
 * Returns the value the transaction holds under `key`, starting it on first
 * use, and calls `finish` with it once the transaction's body is done, still
 * inside the transaction. Savepoints share their transaction's values, even
 * when they roll back.
 */
export function beforeCommit<T>(
  tx: Tx,
  key: symbol,
  start: () => T,
  finish: (tx: Tx, value: T) => Promise<void>
): T {
  const finishes = finishing.get(tx)
  if (!finishes) throw new Error('not in a transaction')
  const held = finishes.get(key)
  if (held) return held.value as T
  const value = start()
  finishes.set(key, {
    value,
    finish: finish as (tx: Tx, value: unknown) => Promise<void>
  })
  return value
}

// Postgres data exceptions (22), integrity violations (23) and program limits
// (54, as a key too long for its index) fail the same way on every retry.
export function postgresRefusal(error: unknown): string | null {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (
      'code' in e &&
      typeof e.code === 'string' &&
      /^(2[23]|54)/.test(e.code)
    ) {
      return `${e.code}: ${e.message}`
    }
  }
  return null
}

// The drizzle migrator takes no lock: replicas starting together would apply
// the same migration. A reserved connection holds the session lock while the
// pool migrates, since drizzle cannot run on a reserved connection.
export async function migrateDb(sql: postgres.Sql): Promise<void> {
  const connection = await sql.reserve()
  try {
    await connection`select pg_advisory_lock(hashtext('migrations'))`
    try {
      await migrate(drizzle({ client: sql }), {
        migrationsFolder: fileURLToPath(
          new URL('../../drizzle', import.meta.url)
        )
      })
    } finally {
      await connection`select pg_advisory_unlock(hashtext('migrations'))`
    }
  } finally {
    connection.release()
  }
}
