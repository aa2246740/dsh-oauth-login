import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPiLoginAuthRoutes } from '../src/auth-routes.ts'
import { OPENROUTER_CATALOG_PATH, OPENROUTER_REFRESH_PATH } from '../src/openrouter-types.ts'
import type { PiLoginSession } from '../src/session.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(connected = true) {
  const routes = new Map<string, Handler>()
  const syncAuthentication = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const snapshot = { version: 1, connected, models: [], lastUpdatedAt: null }
  const session = {
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
    request: async (path: string, method: string, headers = {}, remote = '127.0.0.1') => {
      const req = new IncomingMessage(new Socket())
      Object.defineProperty(req.socket, 'remoteAddress', { value: remote })
      req.method = method
      req.headers = { host: '127.0.0.1:43127', ...headers }
      const res = new ServerResponse(req)
      let body = ''
      vi.spyOn(res, 'writeHead').mockImplementation(status => { res.statusCode = status; return res })
      vi.spyOn(res, 'end').mockImplementation(chunk => { body = String(chunk); return res })
      await routes.get(path)!(req, res)
      req.socket.destroy()
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
