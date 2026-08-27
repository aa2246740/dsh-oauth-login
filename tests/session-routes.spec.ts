import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiLoginCredentialStore } from '../src/store.ts'
import { PiLoginSession } from '../src/session.ts'

async function tempSession(): Promise<PiLoginSession> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-session-'))
  return new PiLoginSession(new PiLoginCredentialStore(join(dir, 'auth.json')))
}

describe('authenticated harness routes', () => {
  it('starts empty and only lists routes with a stored grant', async () => {
    const session = await tempSession()
    expect(await session.authenticatedRoutes()).toEqual([])

    await session.store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires: 1_700_000_000_000,
    }))
    expect(await session.authenticatedRoutes()).toEqual(['pi-xai'])

    await session.store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'codex-access',
      refresh: 'codex-refresh',
      expires: 1_700_000_000_001,
    }))
    expect((await session.authenticatedRoutes()).sort()).toEqual(['pi-openai-codex', 'pi-xai'])

    await session.logout('xai')
    expect(await session.authenticatedRoutes()).toEqual(['pi-openai-codex'])

    await session.logout('openai-codex')
    expect(await session.authenticatedRoutes()).toEqual([])
  })

  it('still exposes grok-4.6 once xAI is signed in', async () => {
    const session = await tempSession()
    await session.store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires: 1_700_000_000_000,
    }))
    expect(session.visibleModels('xai').map(model => model.id)).toContain('grok-4.6')
  })

  it('still exposes stealth/ox-alpha once OpenRouter is signed in', async () => {
    const session = await tempSession()
    await session.store.modify('openrouter', async () => ({
      type: 'oauth',
      access: 'openrouter-access',
      refresh: '',
      expires: 1_700_000_000_000,
    }))
    expect(session.visibleModels('openrouter').map(model => model.id)).toContain('stealth/ox-alpha')
  })

  it('publishes the Zhipu route for a stored Plan API key', async () => {
    const session = await tempSession()
    await session.store.modify('zai-coding-cn', async () => ({
      type: 'api_key',
      key: 'test-zhipu-plan-key',
    }))
    expect(await session.authenticatedRoutes()).toEqual(['pi-zai-coding-cn'])
    expect(session.visibleModels('zai-coding-cn').map(model => model.id)).toContain('glm-5.3-flash')
    expect(session.visibleModels('zai-coding-cn').map(model => model.id)).toContain('glm-5.2')
  })
})
