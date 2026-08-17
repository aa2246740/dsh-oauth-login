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
})
