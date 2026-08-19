/** Proxy-aware HTTP transport for OAuth and subscribed-provider requests. */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'
import { installHostedOutputFetch } from './responses-tap.ts'

const originalFetch = globalThis.fetch
let installedFetch: typeof globalThis.fetch | undefined

const DEFAULT_LOOPBACK_PROXY_CANDIDATES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:45678',
  'http://127.0.0.1:7891',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8888',
] as const

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

export type OAuthProxyResolution =
  | { source: 'environment' }
  | { source: 'explicit' | 'system' | 'loopback', proxyUrl: string }
  | { source: 'direct' }

export interface OAuthProxyDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readSystemProxy?: () => Promise<string | undefined>
  probe?: (proxyUrl: string) => Promise<boolean>
  candidates?: readonly string[]
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('dsh-oauth-login: proxy URL is empty')

  const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-oauth-login: unsupported proxy protocol "${url.protocol}"`)
  }
  if (url.hostname.length === 0) throw new Error('dsh-oauth-login: proxy URL has no host')

  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function inheritedProxy(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value.trim().length > 0) return value
  }
  return undefined
}

function scutilValue(output: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'))
  return match?.[1]
}

function parseMacOSSystemProxy(output: string): string | undefined {
  for (const kind of ['HTTPS', 'HTTP'] as const) {
    if (scutilValue(output, `${kind}Enable`) !== '1') continue
    const host = scutilValue(output, `${kind}Proxy`)
    const port = Number(scutilValue(output, `${kind}Port`))
    if (host === undefined || host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
      continue
    }
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return normalizeProxyUrl(`http://${formattedHost}:${port}`)
  }
  return undefined
}

async function readMacOSSystemProxy(): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(
      '/usr/sbin/scutil',
      ['--proxy'],
      { encoding: 'utf8', timeout: 1_500, maxBuffer: 128 * 1024 },
      (error, stdout) => resolve(error === null ? parseMacOSSystemProxy(stdout) : undefined),
    )
  })
}

function isLoopbackProxy(proxyUrl: string): boolean {
  const hostname = new URL(proxyUrl).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/**
 * Verify that a candidate is an HTTP CONNECT proxy. The probe contains no
 * OAuth code, credential, token, cookie, or geographic metadata.
 */
async function probeHttpConnectProxy(proxyUrl: string): Promise<boolean> {
  const url = new URL(proxyUrl)
  if (url.protocol !== 'http:') return false

  const port = Number(url.port || '80')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false

  return await new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port })
    let settled = false
    let response = ''

    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(accepted)
    }

    socket.setTimeout(800)
    socket.once('connect', () => {
      socket.write(
        'CONNECT auth.openai.com:443 HTTP/1.1\r\n'
        + 'Host: auth.openai.com:443\r\n'
        + 'Connection: close\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      const lineEnd = response.indexOf('\r\n')
      if (lineEnd >= 0) finish(/^HTTP\/1\.[01] 200(?:\s|$)/.test(response.slice(0, lineEnd)))
      else if (response.length > 16 * 1024) finish(false)
    })
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(/^HTTP\/1\.[01] 200(?:\s|$)/.test(response)))
  })
}

export async function resolveOAuthProxy(
  options: OAuthProxyDiscoveryOptions = {},
): Promise<OAuthProxyResolution> {
  const env = options.env ?? process.env
  if (inheritedProxy(env) !== undefined) return { source: 'environment' }

  const explicit = env.DSH_OAUTH_PROXY
  if (explicit !== undefined && explicit.trim().length > 0) {
    return { source: 'explicit', proxyUrl: normalizeProxyUrl(explicit) }
  }

  const probe = options.probe ?? probeHttpConnectProxy
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    const systemProxy = await (options.readSystemProxy ?? readMacOSSystemProxy)()
    if (systemProxy !== undefined) {
      const normalized = normalizeProxyUrl(systemProxy)
      if (await probe(normalized)) return { source: 'system', proxyUrl: normalized }
    }
  }

  const candidates = options.candidates ?? DEFAULT_LOOPBACK_PROXY_CANDIDATES
  const normalizedCandidates = candidates.flatMap((candidate) => {
    try {
      const normalized = normalizeProxyUrl(candidate)
      return isLoopbackProxy(normalized) ? [normalized] : []
    } catch {
      return []
    }
  })
  const results = await Promise.all(normalizedCandidates.map(async candidate => {
    try {
      return await probe(candidate)
    } catch {
      return false
    }
  }))
  const selected = results.findIndex(Boolean)
  if (selected >= 0) return { source: 'loopback', proxyUrl: normalizedCandidates[selected] }

  return { source: 'direct' }
}

function noProxyValue(env: NodeJS.ProcessEnv): string {
  const entries = new Set(
    (env.NO_PROXY ?? env.no_proxy ?? '')
      .split(/[\s,]+/)
      .filter(Boolean),
  )
  entries.add('localhost')
  entries.add('127.0.0.1')
  entries.add('::1')
  return [...entries].join(',')
}

function inheritedProxyOptions(env: NodeJS.ProcessEnv): { httpProxy: string, httpsProxy: string } {
  const allProxy = env.ALL_PROXY ?? env.all_proxy ?? ''
  return {
    httpProxy: env.HTTP_PROXY ?? env.http_proxy ?? allProxy,
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? allProxy,
  }
}

export async function configureOAuthHttpTransport(
  options: OAuthProxyDiscoveryOptions = {},
): Promise<OAuthProxyResolution> {
  const env = options.env ?? process.env
  const resolution = await resolveOAuthProxy({ ...options, env })
  const selectedProxy = 'proxyUrl' in resolution ? resolution.proxyUrl : undefined
  const inherited = inheritedProxyOptions(env)
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    httpProxy: selectedProxy ?? inherited.httpProxy,
    httpsProxy: selectedProxy ?? inherited.httpsProxy,
    noProxy: noProxyValue(env),
  })
  setGlobalDispatcher(dispatcher)

  const shouldInstallFetch = installedFetch === undefined
    ? globalThis.fetch === originalFetch
    : globalThis.fetch === installedFetch
  if (shouldInstallFetch) {
    install()
    installedFetch = globalThis.fetch
  }
  installHostedOutputFetch()
  return resolution
}
