import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiLoginWebAuth } from '../src/auth-routes.ts'
import { PiLoginSession } from '../src/session.ts'
import { PiLoginCredentialStore } from '../src/store.ts'

async function tempSession(): Promise<PiLoginSession> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-web-auth-'))
  const session = new PiLoginSession(new PiLoginCredentialStore(join(dir, 'auth.json')))
  session.ensureTransport = async () => ({ source: 'direct' })
  return session
}

describe('PiLoginWebAuth API-key flow', () => {
  it('opens the official Plan page, accepts a key, and publishes signed-in state', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    try {
      const challenge = await auth.signIn('zai-coding-cn')
      expect(challenge).toMatchObject({
        provider: 'zai-coding-cn',
        kind: 'input',
        url: 'https://bigmodel.cn/coding-plan/personal/overview',
        input: { type: 'secret' },
      })

      const account = await auth.submitInput('zai-coding-cn', '  test-zhipu-plan-key  ')
      expect(account.status).toBe('signed-in')
      const stored = await session.store.read('zai-coding-cn')
      expect(stored?.type === 'api_key' && stored.key).toBe('test-zhipu-plan-key')
      expect(await session.authenticatedRoutes()).toEqual(['pi-zai-coding-cn'])

      const status = (await auth.status()).find(provider => provider.id === 'zai-coding-cn')
      expect(status).toMatchObject({
        authType: 'api_key',
        account: { status: 'signed-in' },
      })
    } finally {
      await auth.dispose()
    }
  })

  it('rejects an empty key and leaves the prompt pending', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    try {
      await auth.signIn('zai-coding-cn')
      await expect(auth.submitInput('zai-coding-cn', '   ')).rejects.toThrow(/must not be empty/)
      expect(await session.store.read('zai-coding-cn')).toBeUndefined()
    } finally {
      await auth.dispose()
    }
  })
})
