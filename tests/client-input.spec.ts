import { describe, expect, it } from 'vitest'
import { applyDraftChange } from '../src/client/draft-input.ts'
import { isAutomaticProxyDraft, proxyDraft, proxyDraftSettings } from '../src/client/proxy-draft.ts'
import { defaultProxySettings } from '../src/proxy-config.ts'
import { loginInputCopy } from '../src/client/login-input-copy.ts'
import { openLoginChallenge } from '../src/client/login-window.ts'

describe('Pi login credential input', () => {
  it('opens the real OAuth URL when the host rejects the reserved blank popup', () => {
    const opened: string[] = []
    expect(openLoginChallenge(null, 'https://auth.openai.com/oauth/authorize', url => opened.push(url))).toBe('fallback')
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize'])
  })
  it('reuses a reserved browser popup without opening a duplicate', () => {
    const replaced: string[] = []
    const opened: string[] = []
    const popup = { close() {}, location: { replace(url: string) { replaced.push(url) } } }
    expect(openLoginChallenge(popup, 'https://auth.openai.com/oauth/authorize', url => opened.push(url))).toBe('reserved')
    expect(replaced).toEqual(['https://auth.openai.com/oauth/authorize'])
    expect(opened).toEqual([])
  })
  it('uses callback copy only for OAuth manual-code challenges and preserves Plan API-key copy', () => {
    expect(loginInputCopy('oauth', 'manual_code')).toEqual({
      waiting: 'waitingForCallback', help: 'callbackHelp', placeholder: 'callbackPlaceholder',
      action: 'submitCallback', required: 'callbackRequired',
    })
    expect(loginInputCopy('api_key', 'secret')).toEqual({
      waiting: 'waitingForCredential', help: 'credentialHelp', placeholder: 'credentialPlaceholder',
      action: 'saveCredential', required: 'credentialRequired',
    })
    expect(loginInputCopy('oauth', 'text').waiting).toBe('waitingForAuthInput')
  })
  it('captures the input value before React clears the synthetic event', () => {
    type Drafts = Record<string, string>
    let pending: ((current: Drafts) => Drafts) | undefined
    const event: { currentTarget: { value: string } | null } = {
      currentTarget: { value: 'test-key-never-submitted' },
    }

    applyDraftChange(
      'zai-coding-cn',
      event as { currentTarget: { value: string } },
      updater => { pending = updater },
    )
    event.currentTarget = null

    expect(pending?.({ existing: 'keep' })).toEqual({
      existing: 'keep',
      'zai-coding-cn': 'test-key-never-submitted',
    })
  })
})

describe('proxy address and port input', () => {
  it('prefills the local address without choosing a port or replacing automatic discovery', () => {
    const draft = proxyDraft(defaultProxySettings())
    expect(draft).toEqual({
      http: { enabled: true, address: 'http://127.0.0.1', port: '' },
      websocket: { enabled: true, address: 'http://127.0.0.1', port: '' },
    })
    expect(isAutomaticProxyDraft(draft.http)).toBe(true)
    draft.websocket.port = '45678'
    expect(isAutomaticProxyDraft(draft.websocket)).toBe(false)
    expect(proxyDraftSettings(draft, 0)).toEqual({
      revision: 0,
      http: { enabled: true, url: '' },
      websocket: { enabled: true, url: 'http://127.0.0.1:45678' },
    })
  })
  it('round trips automatic, disabled and explicit channels', () => {
    const settings = {
      revision: 4,
      http: { enabled: false, url: 'http://127.0.0.1:45678' },
      websocket: { enabled: true, url: 'https://[::1]:8443' },
    }
    expect(proxyDraftSettings(proxyDraft(settings), 4)).toEqual(settings)
    expect(proxyDraftSettings(proxyDraft(defaultProxySettings()), 0)).toEqual(defaultProxySettings())
  })
  it('accepts a host plus port, and a pasted complete proxy URL', () => {
    const draft = proxyDraft(defaultProxySettings())
    draft.http = { enabled: true, address: '127.0.0.1', port: '45678' }
    draft.websocket = { enabled: true, address: 'http://127.0.0.1:7890', port: '' }
    expect(proxyDraftSettings(draft, 1)).toEqual({
      revision: 1,
      http: { enabled: true, url: 'http://127.0.0.1:45678' },
      websocket: { enabled: true, url: 'http://127.0.0.1:7890' },
    })
  })
  it('preserves intentionally configured default ports', () => {
    const settings = {
      revision: 2,
      http: { enabled: true, url: 'http://127.0.0.1' },
      websocket: { enabled: true, url: 'https://proxy.example' },
    }
    const draft = proxyDraft(settings)
    expect(draft.http.port).toBe('80')
    expect(draft.websocket.port).toBe('443')
    expect(proxyDraftSettings(draft, 2)).toEqual(settings)
    draft.http = { enabled: true, address: 'http://127.0.0.1:80', port: '' }
    draft.websocket = { enabled: true, address: 'https://proxy.example:443/', port: '' }
    expect(proxyDraftSettings(draft, 2)).toEqual(settings)
  })
  it.each([
    ['http://127.0.0.1:7890', '45678'], ['', '45678'], ['127.0.0.1', '0'],
    ['127.0.0.1', '65536'], ['127.0.0.1', '4e4'], ['socks5://127.0.0.1', '45678'],
    ['http://user:secret@127.0.0.1', '45678'], ['http://127.0.0.1/path', '45678'],
    ['http://proxy.example', ''], ['https://127.0.0.1', ''],
    ['http://127.0.0.1:80', '45678'], ['https://proxy.example:443/', '8443'],
  ])('rejects ambiguous or unsafe input %s / %s', (address, port) => {
    const draft = proxyDraft(defaultProxySettings())
    draft.websocket = { enabled: true, address, port }
    expect(() => proxyDraftSettings(draft, 0)).toThrow()
  })
})
