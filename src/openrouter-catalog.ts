/** One Host-owned cache/refresh loop. It never receives an OAuth token. */
import { readFile, stat } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { normalizeOpenRouterModels, objectValue, validModelId } from './openrouter-models.ts'
import { OPENROUTER_COOLDOWN_MS, OPENROUTER_REFRESH_MS } from './openrouter-types.ts'
import type { OpenRouterCatalogSnapshot, OpenRouterModel } from './openrouter-types.ts'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_CACHE_FILENAME = '.dsh-oauth-openrouter-models.json'
const MAX_BYTES = 12 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export interface OpenRouterCatalogOptions {
  filename: string
  isAuthenticated: () => Promise<boolean>
  beforeFetch?: () => Promise<unknown>
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** Protect zero-cost legacy selections too, without labelling them free. */
  initiallyProtectedIds?: readonly string[]
}

export class OpenRouterCatalog {
  private entries: OpenRouterModel[] | undefined
  private protectedIds: Set<string>
  private connected = false
  private disposed = false
  private source: OpenRouterCatalogSnapshot['source'] = 'builtin'
  private lastUpdatedAt: number | null = null
  private lastAttemptAt: number | null = null
  private nextRefreshAt: number | null = null
  private error: OpenRouterCatalogSnapshot['error'] = null
  private hydration: Promise<void> | undefined
  private pending: Promise<void> | undefined
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(private readonly options: OpenRouterCatalogOptions) {
    this.now = options.now ?? Date.now
    this.protectedIds = new Set(options.initiallyProtectedIds ?? [])
  }

  models(): readonly OpenRouterModel[] | undefined { return this.entries }
  model(id: string): OpenRouterModel | undefined { return this.entries?.find(model => model.id === id) }
  protects(id: string): boolean {
    return id.endsWith(':free') || id === 'openrouter/free' || this.protectedIds.has(id)
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void {
    for (const listener of this.listeners) {
      // An observer cannot invalidate a successfully loaded catalog.
      try { listener() } catch { /* Host notification is advisory. */ }
    }
  }
  snapshot(): OpenRouterCatalogSnapshot {
    return {
      version: 1,
      connected: this.connected,
      refreshing: this.pending !== undefined,
      source: this.source,
      lastUpdatedAt: this.lastUpdatedAt,
      lastAttemptAt: this.lastAttemptAt,
      nextRefreshAt: this.nextRefreshAt,
      retryAt: this.lastAttemptAt === null ? null : this.lastAttemptAt + OPENROUTER_COOLDOWN_MS,
      stale: this.error !== null || this.lastUpdatedAt === null
        || this.now() - this.lastUpdatedAt >= OPENROUTER_REFRESH_MS,
      error: this.error,
      models: this.connected ? (this.entries ?? []).map(model => ({ ...model, freeOnly: this.protects(model.id) })) : [],
    }
  }
  private hydrate(): Promise<void> {
    this.hydration ??= this.readCache()
    return this.hydration
  }
  private async readCache(): Promise<void> {
    try {
      if ((await stat(this.options.filename)).size > MAX_BYTES) throw new Error('cache too large')
      const raw = objectValue(JSON.parse(await readFile(this.options.filename, 'utf8')))
      if (raw?.version !== 1 || typeof raw.lastUpdatedAt !== 'number'
        || !Number.isFinite(raw.lastUpdatedAt) || raw.lastUpdatedAt <= 0
        || raw.lastUpdatedAt > this.now() + OPENROUTER_COOLDOWN_MS) throw new Error('invalid cache')
      const entries = normalizeOpenRouterModels(raw.data)
      if (this.disposed) return
      this.entries = entries
      this.lastUpdatedAt = raw.lastUpdatedAt
      this.source = 'cache'
      if (Array.isArray(raw.protectedIds)) {
        for (const id of raw.protectedIds) if (validModelId(id)) this.protectedIds.add(id)
      }
      this.rememberFree(entries)
      this.changed()
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.error = 'cache'
    }
  }
  private rememberFree(entries: readonly OpenRouterModel[]): void {
    for (const model of entries) if (model.priceStatus === 'free') this.protectedIds.add(model.id)
  }

  /** Startup reads disk first; only a newly completed login forces a refresh. */
  async syncAuthentication(reason: 'check' | 'login' = 'check'): Promise<void> {
    await this.hydrate()
    const generation = this.generation
    const authenticated = await this.options.isAuthenticated()
    if (this.disposed || generation !== this.generation) return
    if (!authenticated) {
      this.disconnect()
      return
    }
    this.connected = true
    if (reason === 'login' || this.snapshot().stale) {
      void this.refresh(reason === 'login')
    } else if (this.timer === undefined && this.pending === undefined) {
      this.schedule(Math.max(1, OPENROUTER_REFRESH_MS - (this.now() - this.lastUpdatedAt!)))
    }
  }

  /** Coalesced across routes/windows; even forced refreshes honor 60s cooldown. */
  refresh(force = false): Promise<void> {
    if (this.pending !== undefined) return this.pending
    if (!this.connected || this.disposed) return Promise.resolve()
    if (!force && !this.snapshot().stale) return Promise.resolve()
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < OPENROUTER_COOLDOWN_MS) {
      return Promise.resolve()
    }
    const generation = this.generation
    this.lastAttemptAt = this.now()
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    const pending = this.fetchCatalog(signal, generation).finally(() => {
      if (this.pending !== pending) return
      this.pending = undefined
      this.controller = undefined
      if (this.connected && !this.disposed) this.schedule(OPENROUTER_REFRESH_MS)
    })
    this.pending = pending
    return pending
  }

  private async fetchCatalog(signal: AbortSignal, generation: number): Promise<void> {
    try {
      if (!await this.options.isAuthenticated()) {
        this.disconnect()
        return
      }
      await this.options.beforeFetch?.()
      signal.throwIfAborted()
      const response = await (this.options.fetch ?? globalThis.fetch)(OPENROUTER_MODELS_URL, {
        method: 'GET', headers: { accept: 'application/json' }, signal,
        redirect: 'error', credentials: 'omit',
      })
      if (!response.ok || response.body === null) throw new Error('catalog unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) throw new Error('catalog too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      const raw = objectValue(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const links = objectValue(raw?.links)
      // The official non-paginated request must be complete before replacing.
      if (raw === undefined || links?.next != null || !Array.isArray(raw.data)
        || (typeof raw.total_count === 'number' && raw.total_count > raw.data.length)) {
        throw new Error('partial catalog')
      }
      const entries = normalizeOpenRouterModels(raw.data)
      if (this.disposed || !this.connected || generation !== this.generation || signal.aborted) return
      const fetchedAt = this.now()
      const protectedIds = new Set(this.protectedIds)
      for (const model of entries) if (model.priceStatus === 'free') protectedIds.add(model.id)
      try {
        await withFileLock(this.options.filename, async () => {
          // Preserve free-intent history even if another Host shares this DSH home.
          try {
            const cached = objectValue(JSON.parse(await readFile(this.options.filename, 'utf8')))
            if (Array.isArray(cached?.protectedIds)) {
              for (const id of cached.protectedIds) if (validModelId(id)) protectedIds.add(id)
            }
          } catch { /* Missing/invalid cache is replaced by the validated catalog. */ }
          await writeFileAtomic(this.options.filename, JSON.stringify({
            version: 1, lastUpdatedAt: fetchedAt,
            protectedIds: [...protectedIds], data: raw.data,
          }) + '\n', { mode: 0o600, dirMode: 0o700 })
        })
      } catch {
        this.error = 'save'
        return
      }
      if (this.disposed || !this.connected || generation !== this.generation || signal.aborted) return
      // Publish only after free-intent history is durable, so a restart cannot
      // turn a newly selected, suffix-less promotion into a paid request.
      this.entries = entries
      this.protectedIds = protectedIds
      this.lastUpdatedAt = fetchedAt
      this.source = 'live'
      this.error = null
      this.changed()
    } catch {
      if (!this.disposed && this.connected && generation === this.generation) this.error = 'fetch'
    }
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    this.nextRefreshAt = this.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextRefreshAt = null
      void this.syncAuthentication().then(() => this.refresh()).catch(() => {
        if (this.connected && !this.disposed) this.schedule(OPENROUTER_REFRESH_MS)
      })
    }, delay)
    this.timer.unref?.()
  }
  disconnect(): void {
    this.generation += 1
    this.connected = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.nextRefreshAt = null
    this.controller?.abort()
    this.controller = undefined
    this.pending = undefined
  }
  dispose(): void {
    this.disposed = true
    this.disconnect()
    this.listeners.clear()
  }
}
