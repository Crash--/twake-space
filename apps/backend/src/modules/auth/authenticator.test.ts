import { describe, expect, it, vi } from 'vitest'
import { createAuthenticator, gate } from './authenticator.ts'
import type { Identity, IdentityProvider } from './oidc.ts'
import type { AuthStore } from './store.ts'
import { anIdentity } from './testing.ts'

function setUp(
  identity: Identity | null = anIdentity(),
  limits: { newTokenChecks?: number; newTokensWaiting?: number } = {}
) {
  let clock = Date.now()
  const revoked = new Set<string>()
  const provider: IdentityProvider = {
    identify: vi.fn(() => Promise.resolve(identity)),
    verifyLogoutToken: vi.fn()
  }
  const store: AuthStore = {
    isRevoked: sessionId => Promise.resolve(revoked.has(sessionId)),
    revoke: vi.fn()
  }
  const authenticate = createAuthenticator({
    provider,
    store,
    now: () => clock,
    ...limits
  })
  return {
    authenticate,
    identify: provider.identify,
    revoked,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('createAuthenticator', () => {
  it('asks the provider once per token within 60 seconds', async () => {
    const { authenticate, identify, advance } = setUp()

    await authenticate('token')
    advance(59_000)
    await authenticate('token')

    expect(identify).toHaveBeenCalledTimes(1)
  })

  it('asks the provider again after 60 seconds', async () => {
    const { authenticate, identify, advance } = setUp()

    await authenticate('token')
    advance(60_000)
    await authenticate('token')

    expect(identify).toHaveBeenCalledTimes(2)
  })

  it('does not keep a token past its expiry', async () => {
    const identity = anIdentity({ expiresAt: new Date(Date.now() + 10_000) })
    const { authenticate, identify, advance } = setUp(identity)

    await authenticate('token')
    advance(10_000)
    await authenticate('token')

    expect(identify).toHaveBeenCalledTimes(2)
  })

  it('remembers a refused token for 60 seconds', async () => {
    const { authenticate, identify, advance } = setUp(null)

    await expect(authenticate('token')).resolves.toBeNull()
    advance(59_000)
    await expect(authenticate('token')).resolves.toBeNull()
    const within = vi.mocked(identify).mock.calls.length
    advance(1_000)
    await authenticate('token')

    expect(within).toBe(1)
    expect(identify).toHaveBeenCalledTimes(2)
  })

  it('remembers at most 10,000 refused tokens, forgetting the oldest', async () => {
    const { authenticate, identify } = setUp(null)

    for (let i = 0; i <= 10_000; i++) await authenticate(`token-${String(i)}`)
    await authenticate('token-10000')
    await authenticate('token-0')

    expect(identify).toHaveBeenCalledTimes(10_002)
  })

  it('refuses new tokens past 10 checks running and 100 waiting, never one seen before', async () => {
    const { authenticate, identify, advance } = setUp()
    await authenticate('seen')
    const hanging = new Promise<Identity | null>(() => undefined)
    vi.mocked(identify).mockImplementation(token =>
      token === 'seen' ? Promise.resolve(anIdentity()) : hanging
    )

    for (let i = 0; i < 110; i++) void authenticate(`new-${String(i)}`)
    advance(60_000)

    await expect(authenticate('one-too-many')).rejects.toThrow()
    await expect(authenticate('seen')).resolves.not.toBeNull()
  })

  it('holds new tokens to the limits it is given', async () => {
    const { authenticate, identify } = setUp(anIdentity(), {
      newTokenChecks: 1,
      newTokensWaiting: 0
    })
    vi.mocked(identify).mockImplementation(() => new Promise(() => undefined))

    void authenticate('first')

    await expect(authenticate('second')).rejects.toThrow()
  })

  it('keeps a seen token out of a full line while it is checked again', async () => {
    const { authenticate, identify, advance } = setUp()
    await authenticate('seen')
    const recheck = Promise.withResolvers<Identity | null>()
    vi.mocked(identify).mockImplementation(token =>
      token === 'seen' ? recheck.promise : new Promise(() => undefined)
    )

    for (let i = 0; i < 110; i++) void authenticate(`new-${String(i)}`)
    advance(60_000)
    const first = authenticate('seen')
    const second = authenticate('seen')
    recheck.resolve(anIdentity())

    await expect(first).resolves.not.toBeNull()
    await expect(second).resolves.not.toBeNull()
  })

  it('checks a new token once for the requests sent with it at once', async () => {
    const { authenticate, identify } = setUp()

    await Promise.all(Array.from({ length: 20 }, () => authenticate('fresh')))

    expect(identify).toHaveBeenCalledTimes(1)
  })

  it('refuses a cached token once its session is revoked', async () => {
    const { authenticate, revoked } = setUp()

    await expect(authenticate('token')).resolves.not.toBeNull()
    revoked.add('session-1')

    await expect(authenticate('token')).resolves.toBeNull()
  })
})

describe('gate', () => {
  it('runs a waiting task as soon as a running one ends', async () => {
    const pass = gate(1, 1)
    const held = Promise.withResolvers<string>()
    const first = pass(() => held.promise)
    const second = pass(() => Promise.resolve('second'))

    await expect(pass(() => Promise.resolve('third'))).rejects.toThrow()
    held.resolve('first')

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    await expect(pass(() => Promise.resolve('fourth'))).resolves.toBe('fourth')
  })
})
