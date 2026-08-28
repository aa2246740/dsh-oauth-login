/** Plugin-scoped HTTP/WS routing without changing process.env or provider SDKs. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP } from 'node:net'
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { createOAuthHttpTransport, installOAuthHttpGlobals } from './http.ts'
import type { OAuthProxyDiscoveryOptions, OAuthProxyResolution } from './http.ts'
import type { ProxyChannelSettings, ProxySettingsSnapshot } from './proxy-config.ts'
import { ProxySettingsStore } from './proxy-store.ts'

interface RoutingScope {
  http: Dispatcher
  websocket: Dispatcher
  direct: Dispatcher
}

interface RoutingState {
  context: AsyncLocalStorage<RoutingScope>
  dispatcher?: Dispatcher
}

const ROUTING_KEY = Symbol.for('dsh-oauth-login.scoped-proxy.v1')
const globals = globalThis as typeof globalThis & { [ROUTING_KEY]?: RoutingState }
const routing = globals[ROUTING_KEY] ??= { context: new AsyncLocalStorage<RoutingScope>() }

function isLoopback(origin: Dispatcher.DispatchOptions['origin']): boolean {
  if (origin === undefined) return false
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'))
}

function installRouting(): void {
  const fallback = getGlobalDispatcher()
  if (fallback !== routing.dispatcher) {
    routing.dispatcher = fallback.compose(dispatch => (options, handler) => {
      const scope = routing.context.getStore()
      if (scope === undefined) return dispatch(options, handler)
      const websocket = typeof options.upgrade === 'string' && options.upgrade.toLowerCase() === 'websocket'
      const selected = isLoopback(options.origin) ? scope.direct : websocket ? scope.websocket : scope.http
      return selected.dispatch(options, handler)
    })
    setGlobalDispatcher(routing.dispatcher)
  }
  installOAuthHttpGlobals()
}

interface ReadyTransport {
  scope: RoutingScope
  resolution: OAuthProxyResolution
  agents: Set<Dispatcher>
  wsKey: string
  active: number
  retired: boolean
  closing: boolean
}

interface SessionConnection {
  key: string
  active: number
  resetPending: boolean
}

export class OAuthProxyTransport {
  readonly settings: ProxySettingsStore
  private readyPromise?: Promise<ReadyTransport>
  private readonly generations = new Set<ReadyTransport>()
  private readonly sessions = new Map<string, SessionConnection>()
  private disposed = false

  constructor(filename: string, private readonly discovery: OAuthProxyDiscoveryOptions = {}) {
    this.settings = new ProxySettingsStore(filename)
  }

  private async build(): Promise<ReadyTransport> {
    const settings = await this.settings.read()
    const channels = [settings.http, settings.websocket]
    const auto = channels.some(channel => channel.enabled && channel.url === '')
      ? await createOAuthHttpTransport(this.discovery)
      : undefined
    const direct = new Agent({ allowH2: false })
    const agents = new Set<Dispatcher>([direct, ...(auto === undefined ? [] : [auto.dispatcher])])
    const select = (channel: ProxyChannelSettings): Dispatcher => {
      if (!channel.enabled) return direct
      if (channel.url === '') {
        if (auto === undefined) throw new Error('Automatic proxy transport is unavailable')
        return auto.dispatcher
      }
      const proxy = new ProxyAgent({ uri: channel.url, allowH2: false })
      agents.add(proxy)
      return proxy
    }
    const ready: ReadyTransport = {
      scope: { direct, http: select(settings.http), websocket: select(settings.websocket) },
      // Preserve the legacy initialize() result as HTTP-route metadata. The
      // separately configured WS route is never reported as an HTTP proxy.
      resolution: !settings.http.enabled ? { source: 'direct' }
        : settings.http.url !== '' ? { source: 'explicit', proxyUrl: settings.http.url }
        : auto?.resolution ?? { source: 'direct' },
      agents,
      // Refresh auto-discovered connections after a settings save as well.
      wsKey: JSON.stringify(settings.websocket) + (settings.websocket.enabled && !settings.websocket.url ? `:${settings.revision}` : ''),
      active: 0, retired: false, closing: false,
    }
    if (this.disposed) {
      await Promise.allSettled([...agents].map(agent => agent.destroy()))
      throw new Error('OAuth proxy transport disposed')
    }
    this.generations.add(ready)
    installRouting()
    return ready
  }

  private ready(): Promise<ReadyTransport> {
    if (this.disposed) return Promise.reject(new Error('OAuth proxy transport disposed'))
    if (this.readyPromise === undefined) {
      const pending = this.build()
      this.readyPromise = pending
      void pending.catch(() => { if (this.readyPromise === pending) this.readyPromise = undefined })
    }
    return this.readyPromise
  }

  async initialize(): Promise<OAuthProxyResolution> {
    return (await this.ready()).resolution
  }

  private async acquire(): Promise<ReadyTransport> {
    while (true) {
      const ready = await this.ready()
      if (ready.retired) continue
      ready.active++
      return ready
    }
  }

  async save(value: unknown): Promise<ProxySettingsSnapshot> {
    if (this.disposed) throw new Error('OAuth proxy transport disposed')
    const saved = await this.settings.save(value)
    const previous = this.readyPromise
    this.readyPromise = undefined
    void previous?.then(ready => {
      ready.retired = true
      this.release(ready, false)
    }, () => undefined)
    return saved
  }

  private release(ready: ReadyTransport, decrement = true): void {
    if (decrement) ready.active--
    if (ready.retired && ready.active === 0 && !ready.closing) {
      ready.closing = true
      void Promise.allSettled([...ready.agents].map(agent => agent.close())).then(() => {
        this.generations.delete(ready)
      })
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const ready = await this.acquire()
    try {
      installRouting()
      return await routing.context.run(ready.scope, operation)
    } finally { this.release(ready) }
  }

  private beginSession(sessionId: string | undefined, ready: ReadyTransport): (() => void) | undefined {
    if (sessionId === undefined) return undefined
    let record = this.sessions.get(sessionId)
    if (record === undefined) {
      record = { key: ready.wsKey, active: 0, resetPending: false }
      this.sessions.set(sessionId, record)
    }
    if (record.key !== ready.wsKey) record.resetPending = true
    if (record.resetPending && record.active === 0) {
      // Public Pi API: retire the old connection, without clearing its SSE
      // fallback latch or changing any retry budget. Never interrupt active work.
      closeOpenAICodexWebSocketSessions(sessionId)
      record.key = ready.wsKey
      record.resetPending = false
    }
    record.active++
    return () => { record.active-- }
  }

  async * iterate<T>(source: AsyncIterable<T>, codexSessionId?: string): AsyncIterable<T> {
    const ready = await this.acquire()
    let endSession: (() => void) | undefined
    let iterator: AsyncIterator<T> | undefined
    try {
      installRouting()
      endSession = this.beginSession(codexSessionId, ready)
      iterator = routing.context.run(ready.scope, () => source[Symbol.asyncIterator]())
      while (true) {
        const current = iterator
        const item = await routing.context.run(ready.scope, () => current.next())
        if (item.done) return
        yield item.value
      }
    } finally {
      try {
        await routing.context.run(ready.scope, () => iterator?.return?.())
      } finally {
        endSession?.()
        this.release(ready)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.readyPromise?.catch(() => undefined)
    for (const sessionId of this.sessions.keys()) closeOpenAICodexWebSocketSessions(sessionId)
    this.sessions.clear()
    await Promise.allSettled([...this.generations].flatMap(ready => [...ready.agents].map(agent => agent.destroy())))
    this.generations.clear()
  }
}
