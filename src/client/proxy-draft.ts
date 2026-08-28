import { parseProxySettings } from '../proxy-config.ts'
import type { ProxyChannelSettings, ProxySettingsSnapshot } from '../proxy-config.ts'

export interface ProxyChannelDraft {
  enabled: boolean
  address: string
  port: string
}

export type ProxyDraft = Record<'http' | 'websocket', ProxyChannelDraft>

export const DEFAULT_PROXY_ADDRESS = 'http://127.0.0.1'

export function isAutomaticProxyDraft({ address, port }: ProxyChannelDraft): boolean {
  const host = address.trim().replace(/\/$/, '')
  return port.trim() === '' && (host === '' || host === DEFAULT_PROXY_ADDRESS || host === '127.0.0.1')
}

export function proxyDraft(settings: ProxySettingsSnapshot): ProxyDraft {
  const channel = ({ enabled, url }: ProxyChannelSettings): ProxyChannelDraft => {
    if (url === '') return { enabled, address: DEFAULT_PROXY_ADDRESS, port: '' }
    const parsed = new URL(url)
    return {
      enabled,
      address: `${parsed.protocol}//${parsed.hostname}`,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    }
  }
  return { http: channel(settings.http), websocket: channel(settings.websocket) }
}

export function proxyDraftSettings(draft: ProxyDraft, revision: number): ProxySettingsSnapshot {
  const channel = (value: ProxyChannelDraft): ProxyChannelSettings => {
    const { enabled, address, port } = value
    const host = address.trim()
    const portText = port.trim()
    if (isAutomaticProxyDraft(value)) return { enabled, url: '' }
    if (host === '' || (portText !== '' && (!/^\d{1,5}$/.test(portText)
      || Number(portText) < 1 || Number(portText) > 65535))) {
      throw new Error('Enter a proxy address and a port from 1 to 65535')
    }
    const parsed = new URL(host.includes('://') ? host : `http://${host}`)
    // URL.port omits explicit default ports (80/443), so retain the pasted port.
    const pastedPort = /:(\d+)\/?$/.exec(host)?.[1] ?? ''
    if (portText === '' && pastedPort === '') {
      throw new Error('Enter a proxy port from 1 to 65535')
    }
    if (portText !== '') {
      if (pastedPort !== '' && Number(pastedPort) !== Number(portText)) {
        throw new Error('The address and port fields specify different ports')
      }
      parsed.port = portText
    }
    return { enabled, url: parsed.href }
  }
  return parseProxySettings({ revision, http: channel(draft.http), websocket: channel(draft.websocket) })
}
