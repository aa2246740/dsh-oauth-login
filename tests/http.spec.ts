import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { createHash } from 'node:crypto'
import dns from 'node:dns'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { connect } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { configureOAuthHttpTransport, resolveOAuthProxy } from '../src/http.ts'
import { OAuthProxyTransport } from '../src/proxy-transport.ts'
import { defaultProxySettings } from '../src/proxy-config.ts'

describe('OAuth HTTP transport', () => {
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined

  afterEach(async () => {
    if (previousDispatcher !== undefined) {
      const { setGlobalDispatcher } = await import('undici')
      setGlobalDispatcher(previousDispatcher)
      previousDispatcher = undefined
    }
  })

  it('uses proxy-aware undici without mutating process environment', async () => {
    const proxyEnvBefore = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /proxy/i.test(key)),
    )
    previousDispatcher = getGlobalDispatcher()
    await configureOAuthHttpTransport({
      env: {},
      platform: 'linux',
      candidates: [],
    })

    expect(getGlobalDispatcher().constructor.name).toBe('EnvHttpProxyAgent')
    const proxyEnvAfter = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /proxy/i.test(key)),
    )
    expect(proxyEnvAfter).toEqual(proxyEnvBefore)
  })

  it('keeps an inherited proxy authoritative and skips discovery', async () => {
    const readSystemProxy = vi.fn(async () => 'http://127.0.0.1:9000')
    const probe = vi.fn(async () => true)

    await expect(resolveOAuthProxy({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      platform: 'darwin',
      readSystemProxy,
      probe,
    })).resolves.toEqual({ source: 'environment' })
    expect(readSystemProxy).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('prefers the explicit DSH OAuth proxy over every discovered proxy', async () => {
    const readSystemProxy = vi.fn(async () => 'http://127.0.0.1:9000')
    const probe = vi.fn(async () => true)

    await expect(resolveOAuthProxy({
      env: { DSH_OAUTH_PROXY: 'http://127.0.0.1:45678' },
      platform: 'darwin',
      readSystemProxy,
      probe,
    })).resolves.toEqual({
      source: 'explicit',
      proxyUrl: 'http://127.0.0.1:45678/',
    })
    expect(readSystemProxy).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('uses a working macOS system proxy before probing common loopback ports', async () => {
    const probe = vi.fn(async (url: string) => url === 'http://127.0.0.1:9000/')

    await expect(resolveOAuthProxy({
      env: {},
      platform: 'darwin',
      readSystemProxy: async () => 'http://127.0.0.1:9000',
      probe,
      candidates: ['http://127.0.0.1:45678'],
    })).resolves.toEqual({
      source: 'system',
      proxyUrl: 'http://127.0.0.1:9000/',
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('selects the first verified local HTTP CONNECT proxy', async () => {
    const probe = vi.fn(async (url: string) => url.endsWith(':45678/'))

    await expect(resolveOAuthProxy({
      env: {},
      platform: 'linux',
      probe,
      candidates: [
        'http://127.0.0.1:7890',
        'http://127.0.0.1:45678',
      ],
    })).resolves.toEqual({
      source: 'loopback',
      proxyUrl: 'http://127.0.0.1:45678/',
    })
  })

  it('falls back to direct transport when no proxy can be verified', async () => {
    await expect(resolveOAuthProxy({
      env: {},
      platform: 'linux',
      probe: async () => false,
      candidates: ['http://127.0.0.1:45678'],
    })).resolves.toEqual({ source: 'direct' })
  })
})

/** TLS is verified against a test-only CA; no real provider or credentials. */
describe('independent HTTP and WebSocket routing over real TLS connections', () => {
  let cert: string
  let key: string
  let previousCAs: string[]
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher>
  let outside: Agent
  let directory: string
  const transports: OAuthProxyTransport[] = []
  const servers: Server[] = []
  const sockets = new Set<Socket>()
  const hostname = 'oauth-proxy.test'

  beforeAll(async () => {
    cert = await readFile(new URL('./fixtures/network/test-cert.pem', import.meta.url), 'utf8')
    key = await readFile(new URL('./fixtures/network/test-key.pem', import.meta.url), 'utf8')
    previousCAs = tls.getCACertificates('default')
    tls.setDefaultCACertificates([...previousCAs, cert])
  })
  afterAll(() => { tls.setDefaultCACertificates(previousCAs) })
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-proxy-wire-'))
    previousDispatcher = getGlobalDispatcher()
    outside = new Agent({ allowH2: false })
    setGlobalDispatcher(outside)
    const originalLookup = dns.lookup
    type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
    // Node's overloaded function also has a __promisify__ property; this stub
    // only replaces calls and supports both callback arities used by net/tls.
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback) => {
      if (host !== hostname) return Reflect.apply(originalLookup, dns, [host, options, callback])
      const done = typeof options === 'function' ? options : callback!
      queueMicrotask(() => {
        if (typeof options === 'object' && options.all) done(null, [{ address: '127.0.0.1', family: 4 }])
        else done(null, '127.0.0.1', 4)
      })
    }) as unknown as typeof dns.lookup)
  })
  afterEach(async () => {
    await Promise.all(transports.splice(0).map(transport => transport.dispose()))
    await outside.destroy()
    setGlobalDispatcher(previousDispatcher)
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  async function listen(server: Server): Promise<number> {
    servers.push(server)
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected test TCP address')
    return address.port
  }

  async function upstream() {
    const requests: string[] = []
    let slowStarted!: () => void
    let finishSlow!: () => void
    const started = new Promise<void>(resolve => { slowStarted = resolve })
    const server = httpsServer({ key, cert }, (req, res) => {
      requests.push(`http:${req.url}`)
      if (req.url === '/slow') { finishSlow = () => res.end('http-ok'); slowStarted(); return }
      res.end('http-ok')
    })
    server.on('upgrade', (req, socket) => {
      requests.push(`ws:${req.url}`)
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      const payload = Buffer.from('ws-ok')
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
      socket.on('data', data => { if (data[0] === 0x88) socket.end(Buffer.from([0x88, 0])) })
    })
    const port = await listen(server)
    return { port, requests, url: `https://${hostname}:${port}`, started, finish: () => finishSlow() }
  }

  async function proxy(targetPort: number) {
    const connects: string[] = []
    const server = httpServer((_req, res) => { res.writeHead(405); res.end() })
    server.on('connect', (req, client, head) => {
      connects.push(req.url ?? '')
      const target = connect(targetPort, '127.0.0.1')
      sockets.add(target)
      target.on('close', () => sockets.delete(target))
      target.on('error', () => client.destroy())
      client.on('error', () => target.destroy())
      target.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) target.write(head)
        client.pipe(target).pipe(client)
      })
    })
    const port = await listen(server)
    return { connects, url: `http://127.0.0.1:${port}` }
  }

  async function transport(http: string, websocket: string, enabled = [true, true], env: NodeJS.ProcessEnv = {}) {
    const value = new OAuthProxyTransport(join(directory, `proxy-${transports.length}.json`), { env, platform: 'linux', candidates: [] })
    transports.push(value)
    await value.save({
      ...defaultProxySettings(),
      http: { enabled: enabled[0], url: http },
      websocket: { enabled: enabled[1], url: websocket },
    })
    return value
  }

  function websocket(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new globalThis.WebSocket(url.replace(/^https:/, 'wss:'))
      let message = ''
      const timer = setTimeout(() => { socket.close(); reject(new Error('Test WebSocket timeout')) }, 3_000)
      socket.onmessage = event => { message = String(event.data); socket.close() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Test WebSocket failed')) }
      socket.onclose = () => { clearTimeout(timer); message ? resolve(message) : reject(new Error('Closed without test message')) }
    })
  }

  it.each([[true, true], [true, false], [false, true], [false, false]])(
    'routes HTTPS enabled=%s and WSS enabled=%s independently, including direct overrides',
    async (httpEnabled, wsEnabled) => {
      const site = await upstream()
      const a = await proxy(site.port)
      const b = await proxy(site.port)
      const inherited = await proxy(site.port)
      const value = await transport(a.url, b.url, [httpEnabled, wsEnabled], { HTTPS_PROXY: inherited.url })
      expect(await value.initialize()).toEqual(httpEnabled ? { source: 'explicit', proxyUrl: a.url } : { source: 'direct' })
      const before = { ...process.env }
      const output = await value.run(() => Promise.all([
        fetch(`${site.url}/http`, { signal: AbortSignal.timeout(3_000) }).then(response => response.text()),
        websocket(`${site.url}/ws`),
      ]))
      expect(output).toEqual(['http-ok', 'ws-ok'])
      expect(a.connects).toHaveLength(httpEnabled ? 1 : 0)
      expect(b.connects).toHaveLength(wsEnabled ? 1 : 0)
      expect(inherited.connects).toEqual([])
      expect(process.env).toEqual(before)
    },
  )

  it('preserves automatic discovery while keeping requests outside the plugin direct', async () => {
    const site = await upstream()
    const a = await proxy(site.port)
    const value = await transport('', '', [true, true], { HTTPS_PROXY: a.url })
    await value.run(() => Promise.all([fetch(site.url).then(response => response.text()), websocket(site.url)]))
    expect(a.connects).toHaveLength(2)
    await fetch(`${site.url}/outside`).then(response => response.text())
    await websocket(`${site.url}/outside`)
    expect(a.connects).toHaveLength(2)
    expect(site.requests).toContain('ws:/outside')
  })

  it('isolates concurrent plugin scopes and an unrelated request', async () => {
    const site = await upstream()
    const a = await proxy(site.port)
    const b = await proxy(site.port)
    const first = await transport(a.url, a.url)
    const second = await transport(b.url, b.url)
    await first.initialize()
    await second.initialize()
    expect(await Promise.all([
      first.run(() => fetch(`${site.url}/first`).then(response => response.text())),
      second.run(() => websocket(`${site.url}/second`)),
      fetch(`${site.url}/unrelated`).then(response => response.text()),
    ])).toEqual(['http-ok', 'ws-ok', 'http-ok'])
    expect(a.connects).toHaveLength(1)
    expect(b.connects).toHaveLength(1)
  })

  it('bypasses proxy routing for local callbacks on both transports', async () => {
    const site = await upstream()
    const a = await proxy(site.port)
    const value = await transport(a.url, a.url)
    const local = `https://127.0.0.1:${site.port}`
    expect(await value.run(() => fetch(local).then(response => response.text()))).toBe('http-ok')
    expect(await value.run(() => websocket(local))).toBe('ws-ok')
    expect(a.connects).toEqual([])
  })

  it('fails closed on an unavailable explicit proxy instead of silently connecting directly', async () => {
    const site = await upstream()
    const unused = httpServer()
    const port = await listen(unused)
    await new Promise<void>(resolve => unused.close(() => resolve()))
    const value = await transport(`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`)
    await expect(value.run(() => fetch(site.url, { signal: AbortSignal.timeout(3_000) }))).rejects.toThrow()
    await expect(value.run(() => websocket(site.url))).rejects.toThrow()
    expect(site.requests).toEqual([])
  })

  it('applies a saved proxy to new requests without aborting an in-flight request', async () => {
    const site = await upstream()
    const a = await proxy(site.port)
    const b = await proxy(site.port)
    const value = await transport(a.url, a.url)
    const slow = value.run(() => fetch(`${site.url}/slow`).then(response => response.text()))
    await site.started
    await value.save({ ...(await value.settings.read()), http: { enabled: true, url: b.url } })
    expect(await value.run(() => fetch(`${site.url}/new`).then(response => response.text()))).toBe('http-ok')
    site.finish()
    expect(await slow).toBe('http-ok')
    expect(a.connects).toHaveLength(1)
    expect(b.connects).toHaveLength(1)
  })
})
