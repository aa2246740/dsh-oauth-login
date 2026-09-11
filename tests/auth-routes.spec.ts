import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loginInputChallenge, mergeLoginChallenge, PiLoginWebAuth } from '../src/auth-routes.ts'
import { PiLoginSession } from '../src/session.ts'
import { PiLoginCredentialStore } from '../src/store.ts'
import { catalogProvider } from '../src/provider.ts'
import type { OAuthCredential, Provider, ProviderAuthInteraction } from '@earendil-works/pi-ai'

async function tempSession(): Promise<PiLoginSession> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-web-auth-'))
  const session = new PiLoginSession(new PiLoginCredentialStore(join(dir, 'auth.json')), undefined, undefined, {
    env: {}, platform: 'linux', candidates: [],
  })
  session.ensureTransport = async () => ({ source: 'direct' })
  return session
}

describe('PiLoginWebAuth API-key flow', () => {
  it('keeps the browser URL when OAuth advances to a manual callback prompt', () => {
    expect(mergeLoginChallenge({
      provider: 'openai-codex',
      kind: 'browser',
      url: 'https://auth.openai.com/oauth/authorize',
    }, {
      provider: 'openai-codex',
      kind: 'input',
      input: { type: 'manual_code', message: 'Paste the callback URL' },
    })).toEqual({
      provider: 'openai-codex',
      kind: 'input',
      url: 'https://auth.openai.com/oauth/authorize',
      input: { type: 'manual_code', message: 'Paste the callback URL' },
    })
  })

  it('preserves manual callback challenges on the browser contract', () => {
    expect(loginInputChallenge({
      type: 'manual_code',
      message: 'Paste the callback URL',
      placeholder: 'http://localhost/callback?code=…',
    })).toEqual({
      type: 'manual_code',
      message: 'Paste the callback URL',
      placeholder: 'http://localhost/callback?code=…',
    })
  })

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

  it('cancels a pending login without leaving an error state', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    try {
      await auth.signIn('zai-coding-cn')
      await auth.cancel('zai-coding-cn')
      const status = (await auth.status()).find(provider => provider.id === 'zai-coding-cn')
      expect(status?.account).toEqual({ status: 'signed-out' })
    } finally {
      await auth.dispose()
    }
  })

  it('cancels before the first OAuth challenge, retries, and ignores the old completion', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    let attempt = 0
    let releaseOld!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    let markRetryPrompt!: () => void
    const retryPrompt = new Promise<void>(resolve => { markRetryPrompt = resolve })
    let firstSignal: AbortSignal | undefined
    vi.spyOn(session.models, 'login').mockImplementation(async (_providerId, _type, interaction) => {
      attempt += 1
      if (attempt === 1) {
        firstSignal = interaction.signal
        markFirstStarted()
        await new Promise<void>(resolve => { releaseOld = resolve })
        return { type: 'oauth', access: 'stale-access', refresh: 'stale-refresh', expires: Date.now() + 60_000 }
      }
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
      markRetryPrompt()
      await interaction.prompt({ type: 'manual_code', message: 'Paste callback URL', signal: interaction.signal })
      const credential = { type: 'oauth' as const, access: 'retry-access', refresh: 'retry-refresh', expires: Date.now() + 60_000 }
      await session.store.modify('openai-codex', async () => credential)
      return credential
    })
    try {
      const waitingForChallenge = auth.signIn('openai-codex')
      const waitingResult = waitingForChallenge.catch(error => error as Error)
      await firstStarted
      const startedAt = performance.now()
      await auth.cancel('openai-codex')
      expect(performance.now() - startedAt).toBeLessThan(100)
      expect(firstSignal?.aborted).toBe(true)
      expect(await waitingResult).toEqual(expect.objectContaining({ message: expect.stringContaining('cancelled') }))

      await expect(auth.signIn('openai-codex')).resolves.toMatchObject({ kind: 'browser' })
      await retryPrompt
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await auth.signIn('openai-codex')).toMatchObject({ kind: 'input', input: { type: 'manual_code' } })
      releaseOld()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await auth.signIn('openai-codex')).toMatchObject({ kind: 'input', input: { type: 'manual_code' } })

      await expect(auth.submitInput('openai-codex', 'http://localhost/callback?code=fake-retry')).resolves.toMatchObject({ status: 'signed-in' })
      expect(attempt).toBe(2)
    } finally {
      await auth.dispose()
    }
  })

  it('cancels promptly after callback input was submitted even if the provider remains pending', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    let markPrompt!: () => void
    const promptReady = new Promise<void>(resolve => { markPrompt = resolve })
    let markConsumed!: () => void
    const inputConsumed = new Promise<void>(resolve => { markConsumed = resolve })
    let signal: AbortSignal | undefined
    vi.spyOn(session.models, 'login').mockImplementation(async (_providerId, _type, interaction) => {
      signal = interaction.signal
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
      markPrompt()
      await interaction.prompt({ type: 'manual_code', message: 'Paste callback URL', signal: interaction.signal })
      markConsumed()
      await new Promise<void>(() => {})
      return { type: 'oauth', access: 'never', refresh: 'never', expires: Date.now() + 60_000 }
    })
    try {
      await auth.signIn('openai-codex')
      await promptReady
      await new Promise(resolve => setTimeout(resolve, 0))
      const submitting = auth.submitInput('openai-codex', 'http://localhost/callback?code=fake-pending')
      const submissionResult = submitting.catch(error => error as Error)
      await inputConsumed
      const startedAt = performance.now()
      await auth.cancel('openai-codex')
      expect(performance.now() - startedAt).toBeLessThan(100)
      expect(signal?.aborted).toBe(true)
      expect(await submissionResult).toEqual(expect.objectContaining({ message: expect.stringContaining('cancelled') }))
      expect((await auth.status()).find(provider => provider.id === 'openai-codex')?.account).toEqual({ status: 'signed-out' })
    } finally {
      await auth.dispose()
    }
  })

  it('uses real Models.login signal handling so a cancelled fake OAuth provider cannot commit stale credentials', async () => {
    const session = await tempSession()
    const base = catalogProvider('openai-codex')
    const oauth = base.auth.oauth
    if (oauth === undefined) throw new Error('OpenAI fake fixture requires OAuth support')
    let attempt = 0
    let staleSignal: AbortSignal | undefined
    let releaseStale!: () => void
    let markStaleInput!: () => void
    const staleInput = new Promise<void>(resolve => { markStaleInput = resolve })
    const fakeProvider: Provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...oauth,
          login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
            attempt += 1
            interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
            await interaction.prompt({ type: 'manual_code', message: 'Paste callback URL', signal: interaction.signal })
            if (attempt === 1) {
              staleSignal = interaction.signal
              markStaleInput()
              await new Promise<void>(resolve => { releaseStale = resolve })
              return { type: 'oauth', access: 'stale-access', refresh: 'stale-refresh', expires: Date.now() + 60_000 }
            }
            return { type: 'oauth', access: 'retry-access', refresh: 'retry-refresh', expires: Date.now() + 60_000 }
          },
        },
      },
    }
    session.models.setProvider(fakeProvider)
    const setProvider = session.models.setProvider.bind(session.models)
    vi.spyOn(session.models, 'setProvider').mockImplementation(provider => {
      setProvider(provider.id === 'openai-codex' ? fakeProvider : provider)
    })
    const auth = new PiLoginWebAuth(session)
    try {
      await auth.signIn('openai-codex')
      const staleSubmission = auth.submitInput('openai-codex', 'http://localhost/callback?code=stale')
      const staleResult = staleSubmission.catch(error => error as Error)
      await staleInput
      await auth.cancel('openai-codex')
      expect(staleSignal?.aborted).toBe(true)
      releaseStale()
      expect(await staleResult).toEqual(expect.objectContaining({ message: expect.stringContaining('cancelled') }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await session.store.read('openai-codex')).toBeUndefined()

      await auth.signIn('openai-codex')
      await expect(auth.submitInput('openai-codex', 'http://localhost/callback?code=retry')).resolves.toMatchObject({ status: 'signed-in' })
      expect(await session.store.read('openai-codex')).toMatchObject({ type: 'oauth', access: 'retry-access' })
    } finally {
      await auth.dispose()
    }
  })

  it('does not let a delayed cancel snapshot overwrite a newer retry state', async () => {
    const session = await tempSession()
    const auth = new PiLoginWebAuth(session)
    vi.spyOn(session.models, 'login').mockImplementation(async (_providerId, _type, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' })
      await interaction.prompt({ type: 'manual_code', message: 'Paste callback URL', signal: interaction.signal })
      await new Promise<void>(() => {})
      return { type: 'oauth', access: 'never', refresh: 'never', expires: Date.now() + 60_000 }
    })
    const originalRead = session.store.read.bind(session.store)
    let blockNextRead = false
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    vi.spyOn(session.store, 'read').mockImplementation(async (...args) => {
      if (blockNextRead) {
        blockNextRead = false
        markReadStarted()
        await readGate
      }
      return originalRead(...args)
    })
    try {
      await auth.signIn('openai-codex')
      blockNextRead = true
      const cancelling = auth.cancel('openai-codex')
      await readStarted
      await expect(auth.signIn('openai-codex')).resolves.toMatchObject({ kind: 'browser' })
      releaseRead()
      await cancelling
      const current = (await auth.status()).find(provider => provider.id === 'openai-codex')
      expect(current?.account).toMatchObject({ status: 'signing-in', kind: 'input' })
    } finally {
      await auth.dispose()
    }
  })
})
