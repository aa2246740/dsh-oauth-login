import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiLoginCredentialStore } from '../src/store.ts'

async function tempStore(): Promise<PiLoginCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-'))
  return new PiLoginCredentialStore(join(dir, 'auth.json'))
}

describe('PiLoginCredentialStore', () => {
  it('round-trips two providers in one file', async () => {
    const store = await tempStore()
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'codex-access',
      refresh: 'codex-refresh',
      expires: 1_700_000_000_000,
    }))
    await store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires: 1_700_000_000_001,
    }))
    const codex = await store.read('openai-codex')
    const xai = await store.read('xai')
    expect(codex?.type === 'oauth' && codex.access).toBe('codex-access')
    expect(xai?.type === 'oauth' && xai.access).toBe('xai-access')
    const listed = await store.list()
    expect(listed.map(item => item.providerId).sort()).toEqual(['openai-codex', 'xai'])
    expect(JSON.parse(await readFile(store.filename, 'utf8')).version).toBe(1)
  })

  it('allows empty refresh (OpenRouter minted key)', async () => {
    const store = await tempStore()
    await store.modify('openrouter', async () => ({
      type: 'oauth',
      access: 'or-key',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    }))
    const openrouter = await store.read('openrouter')
    expect(openrouter?.type === 'oauth' && openrouter.refresh).toBe('')
  })

  it('reads the legacy DSH filename and writes the new DSH filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-'))
    const store = new PiLoginCredentialStore(join(dir, '.dsh-oauth-auth.json'))
    await writeFile(join(dir, '.pi-login-auth.json'), `${JSON.stringify({
      version: 1,
      credentials: {
        'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
      },
    })}\n`, { mode: 0o600 })

    const legacy = await store.read('openai-codex')
    expect(legacy?.type === 'oauth' && legacy.access).toBe('a')
    await store.modify('openai-codex', async current => current)
    expect(JSON.parse(await readFile(store.filename, 'utf8')).credentials['openai-codex'].access).toBe('a')
  })

  it('refuses unknown providers', async () => {
    const store = await tempStore()
    await expect(store.modify('not-a-provider', async current => current)).rejects.toThrow(/does not own/)
  })

  it('rejects unknown credential fields', async () => {
    const store = await tempStore()
    await writeFile(store.filename, `${JSON.stringify({
      version: 1,
      credentials: {
        xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, leak: 'nope' },
      },
    })}\n`, { mode: 0o600 })
    await chmod(store.filename, 0o600)
    await expect(store.read('xai')).rejects.toThrow(/unknown field/)
  })

  it('deletes one provider and removes the file when empty', async () => {
    const store = await tempStore()
    await store.modify('xai', async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    await store.delete('xai')
    expect(await store.read('xai')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })
})
