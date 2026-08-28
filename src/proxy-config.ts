/** Shared, credential-free settings for this plugin's two outbound transports. */

export const PROXY_SETTINGS_PATH = '/plugins/dsh-oauth-login/network/settings'
export const PROXY_SETTINGS_FILENAME = '.dsh-oauth-proxy.json'

export interface ProxyChannelSettings {
  /** False means direct, even when proxy environment variables are set. */
  enabled: boolean
  /** Empty keeps environment/system discovery; otherwise this URL wins. */
  url: string
}

export interface ProxySettings {
  http: ProxyChannelSettings
  websocket: ProxyChannelSettings
}

export interface ProxySettingsSnapshot extends ProxySettings {
  revision: number
}

export function defaultProxySettings(): ProxySettingsSnapshot {
  return { revision: 0, http: { enabled: true, url: '' }, websocket: { enabled: true, url: '' } }
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label}: invalid settings object`)
  }
  return value as Record<string, unknown>
}

function channel(value: unknown, label: string): ProxyChannelSettings {
  const raw = object(value, ['enabled', 'url'], label)
  if (typeof raw.enabled !== 'boolean' || typeof raw.url !== 'string' || raw.url.length > 1024) {
    throw new Error(`${label}: expected enabled and proxy URL`)
  }
  const text = raw.url.trim()
  if (text === '') return { enabled: raw.enabled, url: '' }
  let parsed: URL
  try { parsed = new URL(text) } catch { throw new Error(`${label}: enter a valid HTTP proxy address and port`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || parsed.port === '0') {
    throw new Error(`${label}: use an HTTP(S) proxy without credentials, path, query or fragment`)
  }
  return { enabled: raw.enabled, url: parsed.origin }
}

export function parseProxySettings(value: unknown): ProxySettingsSnapshot {
  const raw = object(value, ['revision', 'http', 'websocket'], 'Network')
  if (typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw new Error('Network: invalid revision')
  }
  return {
    revision: raw.revision,
    http: channel(raw.http, 'HTTP'),
    websocket: channel(raw.websocket, 'WebSocket'),
  }
}
