import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPiLoginAuthRoutes } from '../src/auth-routes.ts'
import { OPENROUTER_CATALOG_PATH, OPENROUTER_REFRESH_PATH } from '../src/openrouter-types.ts'
import type { PiLoginSession } from '../src/session.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthProxyTransport } from '../src/proxy-transport.ts'
import { defaultProxySettings, PROXY_SETTINGS_PATH } from '../src/proxy-config.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(connected = true, proxy?: OAuthProxyTransport) {
  const routes = new Map<string, Handler>()
  const syncAuthentication = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const snapshot = { version: 1, connected, models: [], lastUpdatedAt: null }
  const session = {
    proxy,
    openRouter: { syncAuthentication, refresh, snapshot: () => snapshot },
  } as unknown as PiLoginSession
  const ctx = {
    webServer: { register: (route: { path: string; handler: Handler }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    } },
    effect: (factory: () => () => Promise<void>) => { cleanups.push(factory()) },
  } as unknown as Context
  registerPiLoginAuthRoutes(ctx, session)
  return {
    syncAuthentication, refresh, snapshot,
    request: async (path: string, method: string, headers = {}, remote = '127.0.0.1', input?: string) => {
      const socket = new Socket()
      const req = new IncomingMessage(socket)
      Object.defineProperty(req.socket, 'remoteAddress', { value: remote })
      req.method = method
      req.headers = { host: '127.0.0.1:43127', ...headers }
      if (input !== undefined) req.push(Buffer.from(input))
      req.push(null)
      const res = new ServerResponse(req)
      let body = ''
      vi.spyOn(res, 'writeHead').mockImplementation(status => { res.statusCode = status; return res })
      vi.spyOn(res, 'end').mockImplementation(chunk => { body = String(chunk); return res })
      await routes.get(path)!(req, res)
      socket.destroy()
      return { status: res.statusCode, body: JSON.parse(body) as unknown }
    },
  }
}

describe('OpenRouter local catalog routes', () => {
  it('returns metadata and permits a same-origin manual refresh', async () => {
    const f = fixture()
    expect(await f.request(OPENROUTER_CATALOG_PATH, 'GET')).toEqual({ status: 200, body: f.snapshot })
    expect(await f.request(OPENROUTER_REFRESH_PATH, 'POST', { origin: 'http://127.0.0.1:43127' }))
      .toEqual({ status: 200, body: f.snapshot })
    expect(f.refresh).toHaveBeenCalledWith(true)
  })
  it('rejects wrong methods before any catalog access', async () => {
    const f = fixture()
    expect((await f.request(OPENROUTER_CATALOG_PATH, 'POST')).status).toBe(405)
    expect((await f.request(OPENROUTER_REFRESH_PATH, 'GET')).status).toBe(405)
    expect(f.syncAuthentication).not.toHaveBeenCalled()
  })
  it('rejects cross-origin and non-loopback requests before refreshing', async () => {
    const f = fixture()
    for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await f.request(OPENROUTER_REFRESH_PATH, 'POST', headers)).status).toBe(403)
    }
    expect((await f.request(OPENROUTER_CATALOG_PATH, 'GET', {}, '192.168.1.2')).status).toBe(403)
    expect(f.syncAuthentication).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
  })
  it('does not refresh after logout and returns a recoverable unavailable response', async () => {
    const f = fixture(false)
    expect((await f.request(OPENROUTER_REFRESH_PATH, 'POST')).status).toBe(409)
    expect(f.refresh).not.toHaveBeenCalled()
    f.syncAuthentication.mockRejectedValueOnce(new Error('private internal detail'))
    const unavailable = await f.request(OPENROUTER_CATALOG_PATH, 'GET')
    expect(unavailable).toEqual({ status: 503, body: { error: 'OpenRouter model catalog unavailable' } })
  })
})

describe('local proxy settings routes', () => {
  async function networkFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-network-routes-'))
    const proxy = new OAuthProxyTransport(join(directory, 'proxy.json'), { env: {}, platform: 'linux', candidates: [] })
    cleanups.push(() => proxy.dispose())
    return { ...fixture(true, proxy), proxy }
  }
  const headers = { origin: 'http://127.0.0.1:43127', 'content-type': 'application/json' }

  it('loads and persists independent settings, rejecting stale revisions', async () => {
    const f = await networkFixture()
    expect(await f.request(PROXY_SETTINGS_PATH, 'GET')).toEqual({ status: 200, body: defaultProxySettings() })
    const next = { ...defaultProxySettings(), websocket: { enabled: true, url: 'http://127.0.0.1:45678' } }
    const saved = await f.request(PROXY_SETTINGS_PATH, 'POST', headers, '127.0.0.1', JSON.stringify(next))
    expect(saved).toEqual({ status: 200, body: { ...next, revision: 1 } })
    expect(await f.proxy.settings.read()).toEqual(saved.body)
    expect((await f.request(PROXY_SETTINGS_PATH, 'POST', headers, '127.0.0.1', JSON.stringify(next))).status).toBe(409)
  })

  it('rejects cross-origin, remote, form and malformed settings without saving', async () => {
    const f = await networkFixture()
    const input = JSON.stringify(defaultProxySettings())
    for (const unsafe of [{ ...headers, origin: 'https://example.com' }, { ...headers, 'sec-fetch-site': 'cross-site' },
      { ...headers, host: 'rebound.example:43127', origin: 'http://rebound.example:43127' }]) {
      expect((await f.request(PROXY_SETTINGS_PATH, 'POST', unsafe, '127.0.0.1', input)).status).toBe(403)
    }
    expect((await f.request(PROXY_SETTINGS_PATH, 'POST', headers, '192.168.1.2', input)).status).toBe(403)
    expect((await f.request(PROXY_SETTINGS_PATH, 'POST', { 'content-type': 'text/plain' }, '127.0.0.1', input)).status).toBe(415)
    expect((await f.request(PROXY_SETTINGS_PATH, 'DELETE')).status).toBe(405)
    for (const body of ['{}', 'x'.repeat(4097), JSON.stringify({ ...defaultProxySettings(), websocket: { enabled: true, url: 'http://u:private@localhost' } })]) {
      const result = await f.request(PROXY_SETTINGS_PATH, 'POST', headers, '127.0.0.1', body)
      expect(result.status).toBe(400)
      expect(JSON.stringify(result.body)).not.toContain('private')
    }
    expect(await f.proxy.settings.read()).toEqual(defaultProxySettings())
  })
})
