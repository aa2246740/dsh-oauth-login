import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiLoginCredentialStore } from '../src/store.ts'
import { ProxySettingsConflict, ProxySettingsStore } from '../src/proxy-store.ts'
import { defaultProxySettings } from '../src/proxy-config.ts'

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

  it('round-trips a Zhipu Plan API key without exposing it from list()', async () => {
    const store = await tempStore()
    await store.modify('zai-coding-cn', async () => ({
      type: 'api_key',
      key: 'test-zhipu-plan-key',
    }))

    const credential = await store.read('zai-coding-cn')
    expect(credential?.type === 'api_key' && credential.key).toBe('test-zhipu-plan-key')
    expect(await store.list()).toEqual([
      { providerId: 'zai-coding-cn', type: 'api_key' },
    ])
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

describe('independent proxy settings store', () => {
  it('persists both channels atomically without touching credentials', async () => {
    const auth = await tempStore()
    await auth.modify('openai-codex', async () => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 1 }))
    const before = await readFile(auth.filename)
    const store = new ProxySettingsStore(join(auth.filename, '..', '.dsh-oauth-proxy.json'))
    expect(await store.read()).toEqual(defaultProxySettings())
    const saved = await store.save({
      revision: 0,
      http: { enabled: false, url: 'http://127.0.0.1:45678/' },
      websocket: { enabled: true, url: 'http://127.0.0.1:7890' },
    })
    expect(saved.http).toEqual({ enabled: false, url: 'http://127.0.0.1:45678' })
    expect(saved.revision).toBe(1)
    expect(await new ProxySettingsStore(store.filename).read()).toEqual(saved)
    expect((await stat(store.filename)).mode & 0o777).toBe(0o600)
    expect(await readFile(auth.filename)).toEqual(before)
    await expect(store.save({ ...saved, revision: 0 })).rejects.toBeInstanceOf(ProxySettingsConflict)
    expect(await store.read()).toEqual(saved)
  })

  it.each([
    'socks5://127.0.0.1:45678', 'http://user:secret@127.0.0.1:45678',
    'http://127.0.0.1:45678/path', 'http://127.0.0.1:45678/?token=secret',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536',
  ])('rejects invalid proxy URLs without saving: %s', async url => {
    const auth = await tempStore()
    const store = new ProxySettingsStore(join(auth.filename, '..', 'proxy.json'))
    await expect(store.save({ ...defaultProxySettings(), websocket: { enabled: true, url } })).rejects.toThrow()
    expect(await store.read()).toEqual(defaultProxySettings())
  })

  it('does not silently fall back to direct traffic when persisted settings are corrupted', async () => {
    const auth = await tempStore()
    const store = new ProxySettingsStore(join(auth.filename, '..', 'proxy.json'))
    await writeFile(store.filename, '{invalid')
    await expect(store.read()).rejects.toThrow(/valid JSON/)
    await expect(store.save(defaultProxySettings())).rejects.toThrow(/valid JSON/)
    expect(await readFile(store.filename, 'utf8')).toBe('{invalid')
  })
})
