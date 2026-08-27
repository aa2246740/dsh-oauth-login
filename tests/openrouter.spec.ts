import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { OpenRouterCatalog, OPENROUTER_MODELS_URL } from '../src/openrouter-catalog.ts'
import { classifyOpenRouterPricing, normalizeOpenRouterModels, openRouterPiModel } from '../src/openrouter-models.ts'
import { prepareOpenRouterOptions, protectOpenRouterPayload } from '../src/openrouter-free.ts'
import { OPENROUTER_COOLDOWN_MS, OPENROUTER_REFRESH_MS } from '../src/openrouter-types.ts'
import { PiLoginSession } from '../src/session.ts'
import { PiLoginCredentialStore } from '../src/store.ts'
import { createPiLoginAdapter } from '../src/adapter.ts'

const directories: string[] = []
const catalogs: OpenRouterCatalog[] = []
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function row(id = 'minimax/minimax-m3:free', pricing: unknown = { prompt: '0', completion: '0' }) {
  return {
    id, name: 'MiniMax M3', context_length: 1_048_576,
    top_provider: { max_completion_tokens: 943_718 },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens'],
    pricing, reasoning: { mandatory: false }, expiration_date: null,
  }
}
function response(data: unknown[] = [row()]) {
  return new Response(JSON.stringify({ data, links: { next: null }, total_count: data.length }))
}
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openrouter-test-'))
  directories.push(dir)
  return dir
}
async function fixture(fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response())) {
  let now = Date.now()
  let authenticated = true
  const filename = join(await tempDir(), 'models.json')
  const catalog = new OpenRouterCatalog({
    filename, isAuthenticated: async () => authenticated, fetch, now: () => now,
  })
  catalogs.push(catalog)
  return {
    catalog, fetch, filename,
    advance: (ms: number) => { now += ms },
    setAuthenticated: (value: boolean) => { authenticated = value },
  }
}

describe('official OpenRouter model metadata', () => {
  it('classifies all cost fields, not a :free suffix or pi-ai zero defaults', () => {
    expect(classifyOpenRouterPricing({ prompt: '0', completion: '0', image: '0', request: '0' }).priceStatus).toBe('free')
    for (const extra of ['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'audio', 'new_cost']) {
      expect(classifyOpenRouterPricing({ prompt: '0', completion: '0', [extra]: '0.000001' }).priceStatus).toBe('paid')
    }
    for (const bad of [undefined, {}, { prompt: '0' }, { prompt: null, completion: '0' }, { prompt: '', completion: '0' }]) {
      expect(classifyOpenRouterPricing(bad).priceStatus).toBe('unknown')
    }
    expect(classifyOpenRouterPricing({ prompt: '1e-999', completion: '0' }).priceStatus).toBe('paid')
    expect(classifyOpenRouterPricing({ prompt: '0', completion: '0', overrides: [{ utc_start: 0, prompt: '1' }] }).priceStatus).toBe('unknown')
    expect(classifyOpenRouterPricing({ prompt: '0', completion: '0', overrides: { new_condition: true } }).priceStatus).toBe('unknown')
    expect(normalizeOpenRouterModels([row('not-a-free-suffix/model')])[0].priceStatus).toBe('free')
    expect(normalizeOpenRouterModels([row('fake/model:free', { prompt: '1', completion: '1' })])[0].priceStatus).toBe('paid')
  })

  it('projects the live context, capabilities and explicit reasoning efforts to a real pi model', () => {
    const source = { ...row(), reasoning: { mandatory: true, supported_efforts: ['low', 'high', 'max'], default_effort: 'max' }, expiration_date: '2026-09-01' }
    const [info] = normalizeOpenRouterModels([source])
    expect(info).toMatchObject({ tools: true, reasoning: true, reasoningMandatory: true, deprecatesAt: '2026-09-01' })
    expect(info).not.toHaveProperty('promotionEndsAt')
    const model = openRouterPiModel(info)
    expect(model).toMatchObject({
      id: source.id, contextWindow: 1_048_576, maxTokens: 943_718,
      input: ['text', 'image'], api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
    })
    expect(getSupportedThinkingLevels(model)).toEqual(['low', 'high', 'max'])
  })

  it('rejects empty/broken catalogs and excludes batch/image-only endpoints', () => {
    expect(() => normalizeOpenRouterModels([])).toThrow()
    expect(() => normalizeOpenRouterModels([{ ...row(), context_length: null }])).toThrow()
    expect(normalizeOpenRouterModels([
      row(), row('minimax/minimax-m3:batch'),
      { ...row('image/generator'), architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    ])).toHaveLength(1)
  })

  it('accepts current official tilde-prefixed latest-model aliases without losing the catalog', () => {
    const result = normalizeOpenRouterModels([row('~openai/gpt-latest', { prompt: '0.001', completion: '0.002' }), row()])
    expect(result.map(model => model.id)).toEqual(['~openai/gpt-latest', 'minimax/minimax-m3:free'])
    expect(() => normalizeOpenRouterModels([row('@private-preset')])).toThrow(/ID/)
  })
})

describe('Host-owned OpenRouter sync', () => {
  it('fetches after login without a key; coalesces all windows and honors the manual cooldown', async () => {
    const f = await fixture()
    await f.catalog.syncAuthentication('login')
    await Promise.all([f.catalog.refresh(true), f.catalog.refresh(true), f.catalog.refresh()])
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, expect.objectContaining({
      headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error',
    }))
    expect(f.catalog.snapshot()).toMatchObject({ connected: true, refreshing: false, source: 'live', stale: false, error: null })
    await f.catalog.refresh(true)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    f.advance(OPENROUTER_COOLDOWN_MS)
    await f.catalog.refresh(true)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect((await readFile(f.filename, 'utf8'))).not.toContain('apiKey')
  })

  it('shows a persisted cache on restart without refetching until stale', async () => {
    const f = await fixture()
    await f.catalog.syncAuthentication()
    await f.catalog.refresh()
    f.catalog.dispose()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response())
    const reboot = new OpenRouterCatalog({ filename: f.filename, isAuthenticated: async () => true, fetch })
    catalogs.push(reboot)
    await reboot.syncAuthentication()
    expect(reboot.models()?.[0].id).toBe(row().id)
    expect(reboot.snapshot().source).toBe('cache')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes every 15 minutes and stops its timer on logout', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await f.catalog.syncAuthentication()
    await f.catalog.refresh()
    f.advance(OPENROUTER_REFRESH_MS)
    await vi.advanceTimersByTimeAsync(OPENROUTER_REFRESH_MS)
    await f.catalog.refresh()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.setAuthenticated(false)
    await f.catalog.syncAuthentication()
    f.advance(OPENROUTER_REFRESH_MS * 2)
    await vi.advanceTimersByTimeAsync(OPENROUTER_REFRESH_MS * 2)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.catalog.snapshot()).toMatchObject({ connected: false, nextRefreshAt: null, models: [] })
  })

  it('keeps the last-good list and timestamp on failure or an incomplete response', async () => {
    const f = await fixture()
    await f.catalog.syncAuthentication()
    await f.catalog.refresh()
    const before = f.catalog.snapshot()
    f.advance(OPENROUTER_REFRESH_MS)
    f.fetch.mockImplementationOnce(async () => new Response('', { status: 503 }))
    await f.catalog.refresh()
    expect(f.catalog.snapshot()).toMatchObject({ error: 'fetch', stale: true, lastUpdatedAt: before.lastUpdatedAt, models: before.models })
    f.advance(OPENROUTER_COOLDOWN_MS)
    f.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ data: [row()], links: { next: '/models?offset=1' } })))
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().models).toEqual(before.models)
    f.advance(OPENROUTER_COOLDOWN_MS)
    f.fetch.mockImplementationOnce(async () => response([]))
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().models).toEqual(before.models)
  })

  it('never fetches while signed out, and a late response cannot reactivate a logout', async () => {
    const f = await fixture()
    f.setAuthenticated(false)
    await f.catalog.syncAuthentication()
    await f.catalog.refresh(true)
    expect(f.fetch).not.toHaveBeenCalled()
    let finish!: (value: Response) => void
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    f.setAuthenticated(true)
    await f.catalog.syncAuthentication('login')
    const pending = f.catalog.refresh()
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    f.catalog.disconnect()
    finish(response())
    await pending
    expect(f.catalog.models()).toBeUndefined()
    expect(f.catalog.snapshot()).toMatchObject({ connected: false, lastUpdatedAt: null, models: [] })
  })

  it('does not turn a corrupted cache into an empty or falsely free live catalog', async () => {
    const f = await fixture()
    await writeFile(f.filename, '{broken')
    f.setAuthenticated(false)
    await f.catalog.syncAuthentication()
    expect(f.catalog.models()).toBeUndefined()
    expect(f.catalog.snapshot()).toMatchObject({ error: 'cache', source: 'builtin' })
  })

  it('persists free protection after a promotion becomes paid on the same model ID', async () => {
    const f = await fixture(vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response([row('vendor/promo')])))
    await f.catalog.syncAuthentication()
    await f.catalog.refresh()
    f.advance(OPENROUTER_COOLDOWN_MS)
    f.fetch.mockImplementationOnce(async () => response([row('vendor/promo', { prompt: '0.001', completion: '0.002' })]))
    await f.catalog.refresh(true)
    expect(f.catalog.model('vendor/promo')?.priceStatus).toBe('paid')
    expect(f.catalog.protects('vendor/promo')).toBe(true)
    f.catalog.dispose()
    const reboot = new OpenRouterCatalog({ filename: f.filename, isAuthenticated: async () => false })
    catalogs.push(reboot)
    await reboot.syncAuthentication()
    expect(reboot.protects('vendor/promo')).toBe(true)
  })

  it('does not advertise a new free model when its guard history cannot be saved', async () => {
    const filename = await tempDir()
    const catalog = new OpenRouterCatalog({
      filename, isAuthenticated: async () => true,
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response()),
    })
    catalogs.push(catalog)
    await catalog.syncAuthentication()
    await catalog.refresh()
    expect(catalog.models()).toBeUndefined()
    expect(catalog.snapshot().error).toBe('save')
  })

  it('makes a newly discovered model resolve through the actual DSH adapter', async () => {
    const session = new PiLoginSession(new PiLoginCredentialStore(join(await tempDir(), 'auth.json')), undefined, {
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response([
        { ...row('minimax/minimax-m2.7:free'), reasoning: { mandatory: true } },
      ])),
    })
    catalogs.push(session.openRouter)
    session.ensureTransport = async () => ({ source: 'direct' })
    await session.store.modify('openrouter', async () => ({ type: 'api_key', key: 'test-not-a-real-key' }))
    await session.openRouter.syncAuthentication('login')
    await session.openRouter.refresh()
    const adapter = createPiLoginAdapter(session, () => undefined)
    expect((await adapter.listModels('pi-openrouter')).map(model => model.id)).toEqual(['minimax/minimax-m2.7:free'])
    expect(await adapter.resolveModel('pi-openrouter', 'minimax/minimax-m2.7:free')).toMatchObject({
      id: 'minimax/minimax-m2.7:free',
      context: { contextWindow: 1_048_576 },
      reasoning: { defaultEffort: 'high' },
    })
    expect(session.visibleModels('xai').some(model => model.id === 'grok-4.6')).toBe(true)
    expect(session.visibleModels('zai-coding-cn').some(model => model.id === 'glm-5.3-flash')).toBe(true)
  })
})

describe('free-only outbound payload', () => {
  function model(id = 'vendor/free-model'): Model<Api> {
    return openRouterPiModel(normalizeOpenRouterModels([row(id)])[0])
  }
  it('pins the ID, zeroes every price cap and removes paid fallbacks/plugins', () => {
    const original = {
      model: 'paid/model', models: ['paid/fallback'], route: 'fallback', preset: 'paid-preset',
      plugins: [{ id: 'web' }], web_search_options: { max_results: 10 },
      modalities: ['image'], audio: {}, image_config: {},
      provider: { allow_fallbacks: true, max_price: { prompt: 10 }, data_collection: 'deny' },
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    }
    const protectedPayload = protectOpenRouterPayload(original, 'minimax/minimax-m3:free')
    expect(protectedPayload).toMatchObject({
      model: 'minimax/minimax-m3:free', plugins: expect.arrayContaining([{ id: 'web', enabled: false }, { id: 'file-parser', enabled: false }]), modalities: ['text'],
      provider: { allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
        max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 } },
      tools: original.tools,
    })
    for (const key of ['models', 'route', 'preset', 'web_search_options', 'audio', 'image_config']) {
      expect(protectedPayload).not.toHaveProperty(key)
    }
    expect(original.provider.max_price.prompt).toBe(10)
  })
  it('runs after user payload hooks, including hooks that mutate then return undefined', async () => {
    const sample = model()
    const options = prepareOpenRouterOptions(sample, { onPayload: async (payload: unknown) => {
      Object.assign(payload as object, { models: ['paid/fallback'], provider: { max_price: { prompt: 99 } } })
      return undefined
    } })
    expect(await options.onPayload!({}, sample)).toMatchObject({
      model: sample.id, provider: { max_price: { prompt: 0 } },
    })
  })
  it('blocks a stale free selection after live pricing changes, even without a :free suffix', async () => {
    const f = await fixture(vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response([row('vendor/promo')])))
    await f.catalog.syncAuthentication()
    await f.catalog.refresh()
    const oldModel = model('vendor/promo')
    const options = prepareOpenRouterOptions(oldModel, {}, f.catalog)
    f.advance(OPENROUTER_COOLDOWN_MS)
    f.fetch.mockImplementationOnce(async () => response([row('vendor/promo', { prompt: '1', completion: '1' })]))
    await f.catalog.refresh(true)
    await expect((options as { onPayload: (p: unknown, m: Model<Api>) => Promise<unknown> }).onPayload({}, oldModel)).rejects.toThrow(/已阻止付费/)
  })
  it('refuses paid hosted tools and file parsers while preserving local function tools', () => {
    expect(() => protectOpenRouterPayload({ tools: [{ type: 'web_search' }] }, 'vendor/free')).toThrow(/收费/)
    expect(() => protectOpenRouterPayload({ messages: [{ content: [{ type: 'file' }] }] }, 'vendor/free')).toThrow(/收费/)
  })
  it('leaves paid requests unchanged', async () => {
    const paid = { ...model('vendor/paid'), cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
    const options = prepareOpenRouterOptions(paid, {})
    const payload = { model: paid.id, plugins: [{ id: 'web' }], provider: { allow_fallbacks: true } }
    expect(await (options as { onPayload: (p: unknown, m: Model<Api>) => Promise<unknown> }).onPayload(payload, paid)).toBe(payload)
  })

  it('sends zero-price limits through the actual pi-ai transport, not just a UI flag', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      'data: ' + JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1,
        model: 'minimax/minimax-m3:free',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetch)
    const session = new PiLoginSession(new PiLoginCredentialStore(join(await tempDir(), 'auth.json')), undefined, {
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response()),
    })
    catalogs.push(session.openRouter)
    session.ensureTransport = async () => ({ source: 'direct' })
    await session.store.modify('openrouter', async () => ({ type: 'api_key', key: 'test-only-key' }))
    await session.openRouter.syncAuthentication()
    await session.openRouter.refresh()
    const provider = session.provider('openrouter')
    const chosen = provider.getModels()[0]
    const events = []
    for await (const event of provider.streamSimple(chosen, {
      messages: [{ role: 'user', content: 'Say ok', timestamp: Date.now() }],
    }, { apiKey: 'test-only-key', maxTokens: 16, maxRetries: 0 })) events.push(event)
    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(events.some(event => event.type === 'done')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'minimax/minimax-m3:free',
      provider: { max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
      plugins: expect.arrayContaining([{ id: 'web', enabled: false }]),
    })
  })
})
