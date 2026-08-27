import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterCatalogClient } from '../src/client/openrouter-store.ts'
import { OPENROUTER_CATALOG_PATH, OPENROUTER_REFRESH_PATH } from '../src/openrouter-types.ts'
import type { OpenRouterCatalogSnapshot } from '../src/openrouter-types.ts'

const clients: OpenRouterCatalogClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  vi.useRealTimers()
})
const snapshot: OpenRouterCatalogSnapshot = {
  version: 1, connected: true, refreshing: false, source: 'live', models: [],
  lastUpdatedAt: 1_700_000_000_000, lastAttemptAt: 1_700_000_000_000,
  nextRefreshAt: null, retryAt: null, stale: false, error: null,
}
function client(fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(snapshot)))) {
  const store = new OpenRouterCatalogClient(fetch)
  clients.push(store)
  return { store, fetch }
}
describe('shared OpenRouter browser metadata', () => {
  it('coalesces concurrent reads and manual requests across component subscribers', async () => {
    const f = client()
    const first = f.store.subscribe(() => {})
    const second = f.store.subscribe(() => {})
    await Promise.all([f.store.load(), f.store.load()])
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls[0][0]).toBe(OPENROUTER_CATALOG_PATH)
    await f.store.load(true)
    expect(f.fetch.mock.calls[1][0]).toBe(OPENROUTER_REFRESH_PATH)
    expect(f.fetch.mock.calls[1][1]?.method).toBe('POST')
    first()
    second()
  })
  it('retains the last list after a local route failure and identifies a pending Host restart', async () => {
    const f = client()
    await f.store.load()
    f.fetch.mockImplementationOnce(async () => new Response('', { status: 503 }))
    await f.store.load(true)
    expect(f.store.getSnapshot()).toMatchObject({ data: { ...snapshot, stale: true }, error: 'unavailable', loading: false })
    f.fetch.mockImplementationOnce(async () => new Response('', { status: 404 }))
    await f.store.load(true)
    expect(f.store.getSnapshot()).toMatchObject({ data: { ...snapshot, stale: true }, error: 'restart' })
  })
  it('stops metadata polls after the last consumer leaves', async () => {
    vi.useFakeTimers()
    const f = client()
    const stop = f.store.subscribe(() => {})
    await f.store.load()
    stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed metadata without blanking the previous UI state', async () => {
    const f = client()
    await f.store.load()
    f.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ...snapshot, models: [null] })))
    await f.store.load(true)
    expect(f.store.getSnapshot()).toMatchObject({ data: { ...snapshot, stale: true }, error: 'unavailable' })
  })
})
