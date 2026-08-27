import { OPENROUTER_CATALOG_PATH, OPENROUTER_REFRESH_PATH } from '../openrouter-types.ts'
import type { OpenRouterCatalogSnapshot } from '../openrouter-types.ts'

export interface OpenRouterClientState {
  data: OpenRouterCatalogSnapshot | null
  loading: boolean
  error: 'unavailable' | 'restart' | null
}

function validSnapshot(value: unknown): value is OpenRouterCatalogSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Record<string, unknown>
  const timestamp = (entry: unknown) => entry === null
    || typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry <= 8.64e15
  if (data.version !== 1 || typeof data.connected !== 'boolean'
    || typeof data.refreshing !== 'boolean' || typeof data.stale !== 'boolean'
    || !timestamp(data.lastUpdatedAt) || !timestamp(data.lastAttemptAt)
    || !timestamp(data.nextRefreshAt) || !timestamp(data.retryAt)
    || !Array.isArray(data.models) || data.models.length > 10_000) return false
  return data.models.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false
    const model = entry as Record<string, unknown>
    return typeof model.id === 'string' && typeof model.name === 'string'
      && typeof model.tools === 'boolean' && typeof model.freeOnly === 'boolean'
      && typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
      && ['free', 'paid', 'unknown'].includes(String(model.priceStatus))
  })
}

/** One metadata store/poll per browser plugin, shared by settings and menus. */
export class OpenRouterCatalogClient {
  private state: OpenRouterClientState = { data: null, loading: false, error: null }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<void> | undefined
  private controller: AbortController | undefined
  private poll: ReturnType<typeof setTimeout> | undefined
  private lastRead = -Infinity
  private disposed = false

  constructor(private readonly request: typeof globalThis.fetch = (...args) => globalThis.fetch(...args)) {}

  getSnapshot = (): OpenRouterClientState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && !this.disposed) void this.load()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        clearTimeout(this.poll)
        this.poll = undefined
      }
    }
  }
  private update(state: OpenRouterClientState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  private failed(error: OpenRouterClientState['error']): void {
    if (this.disposed) return
    this.update({ ...this.state, error,
      data: this.state.data === null ? null : { ...this.state.data, stale: true },
    })
  }

  load = (force = false): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    if (!force && Date.now() - this.lastRead < 1500) {
      this.schedule()
      return Promise.resolve()
    }
    this.lastRead = Date.now()
    clearTimeout(this.poll)
    this.poll = undefined
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])
    this.update({ ...this.state, loading: true, error: null })
    const pending = this.read(force, signal).finally(() => {
      if (this.pending !== pending) return
      this.pending = undefined
      this.controller = undefined
      if (!this.disposed) {
        this.update({ ...this.state, loading: false })
        this.schedule()
      }
    })
    this.pending = pending
    return pending
  }
  private async read(force: boolean, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.request(force ? OPENROUTER_REFRESH_PATH : OPENROUTER_CATALOG_PATH, {
        method: force ? 'POST' : 'GET', credentials: 'same-origin',
        headers: { accept: 'application/json' }, signal,
      })
      if (response.status === 404) {
        this.failed('restart')
        return
      }
      if (!response.ok) throw new Error('catalog unavailable')
      const data: unknown = await response.json()
      if (!validSnapshot(data)) {
        throw new Error('invalid catalog response')
      }
      if (!this.disposed) this.update({ ...this.state, data, error: null })
    } catch {
      this.failed('unavailable')
    }
  }
  private schedule(): void {
    if (this.disposed || this.listeners.size === 0) return
    clearTimeout(this.poll)
    // This is a local metadata read, NOT an upstream model refresh.
    this.poll = setTimeout(() => { void this.load() }, this.state.data?.refreshing ? 2000 : 60_000)
  }
  dispose(): void {
    this.disposed = true
    clearTimeout(this.poll)
    this.controller?.abort()
    this.listeners.clear()
  }
}
