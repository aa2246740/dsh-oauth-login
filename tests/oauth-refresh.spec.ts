import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRefreshAttempts,
  grantNeedsRefresh,
  OAUTH_REFRESH_COOLDOWN_MS,
  OAUTH_REFRESH_SOON_MS,
  refreshGrant,
} from '../src/oauth-refresh.ts'
import { PiLoginCredentialStore } from '../src/store.ts'
import { PiLoginSession } from '../src/session.ts'

afterEach(() => {
  clearRefreshAttempts()
})

describe('grantNeedsRefresh', () => {
  it('is true at and after the stored stamp, and inside the soon window', () => {
    const expires = 1_000_000
    expect(grantNeedsRefresh(expires, expires)).toBe(true)
    expect(grantNeedsRefresh(expires, expires + 1)).toBe(true)
    expect(grantNeedsRefresh(expires, expires - OAUTH_REFRESH_SOON_MS)).toBe(true)
    expect(grantNeedsRefresh(expires, expires - OAUTH_REFRESH_SOON_MS - 1)).toBe(false)
  })
})

describe('refreshGrant', () => {
  it('returns failed without throwing when getAuth rejects', async () => {
    await expect(refreshGrant(async () => {
      throw new Error('cloudflare')
    }, 'xai')).resolves.toBe('failed')
  })
})

describe('PiLoginSession.refreshStoredGrants', () => {
  async function sessionWithXai(expires: number): Promise<PiLoginSession> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-refresh-'))
    const session = new PiLoginSession(new PiLoginCredentialStore(join(dir, 'auth.json')))
    await session.store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires,
    }))
    return session
  }

  it('calls getAuth for an expired grant and skips a fresh one', async () => {
    const stale = await sessionWithXai(Date.now() - 60_000)
    const fresh = await sessionWithXai(Date.now() + 6 * 60 * 60 * 1000)
    const staleAuth = vi.fn(async () => ({ auth: { apiKey: 'n' }, source: 'OAuth' as const }))
    const freshAuth = vi.fn(async () => ({ auth: { apiKey: 'n' }, source: 'OAuth' as const }))
    stale.models.getAuth = staleAuth
    fresh.models.getAuth = freshAuth
    stale.ensureTransport = async () => ({ source: 'direct' as const })
    fresh.ensureTransport = async () => ({ source: 'direct' as const })

    await stale.refreshStoredGrants()
    await fresh.refreshStoredGrants()

    expect(staleAuth).toHaveBeenCalledOnce()
    expect(staleAuth).toHaveBeenCalledWith('xai')
    expect(freshAuth).not.toHaveBeenCalled()
  })

  it('does not delete the grant when refresh fails, and cools down', async () => {
    const session = await sessionWithXai(Date.now() - 60_000)
    const getAuth = vi.fn(async () => {
      throw new Error('blocked')
    })
    session.models.getAuth = getAuth
    session.ensureTransport = async () => ({ source: 'direct' as const })

    await session.refreshStoredGrants()
    await session.refreshStoredGrants()
    const kept = await session.store.read('xai')

    expect(getAuth).toHaveBeenCalledOnce()
    expect(kept?.type).toBe('oauth')
    expect(kept && kept.type === 'oauth' ? kept.refresh : '').toBe('xai-refresh')
  })

  it('retries after the cooldown window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'))
    try {
      const session = await sessionWithXai(Date.now() - 60_000)
      const getAuth = vi.fn(async () => {
        throw new Error('blocked')
      })
      session.models.getAuth = getAuth
      session.ensureTransport = async () => ({ source: 'direct' as const })

      await session.refreshStoredGrants()
      vi.advanceTimersByTime(OAUTH_REFRESH_COOLDOWN_MS + 1)
      await session.refreshStoredGrants()
      expect(getAuth).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
