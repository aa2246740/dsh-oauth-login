import { useCallback, useEffect, useId, useState } from 'react'
import { PROXY_SETTINGS_PATH, parseProxySettings } from '../proxy-config.ts'
import type { ProxySettingsSnapshot } from '../proxy-config.ts'
import { DEFAULT_PROXY_ADDRESS, isAutomaticProxyDraft, proxyDraft, proxyDraftSettings } from './proxy-draft.ts'
import type { ProxyChannelDraft, ProxyDraft } from './proxy-draft.ts'
import type { PiLoginKey } from './locales.ts'

type Translate = (key: PiLoginKey) => string

/** Independent of account loading, so a broken network never hides its settings. */
export function ProxySettings({ t }: { t: Translate }) {
  const id = useId()
  const [settings, setSettings] = useState<ProxySettingsSnapshot>()
  const [draft, setDraft] = useState<ProxyDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PiLoginKey>()
  const [saved, setSaved] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const response = await fetch(PROXY_SETTINGS_PATH, { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error('Settings unavailable')
      const value = parseProxySettings(await response.json())
      if (signal?.aborted) return
      setSettings(value)
      setDraft(proxyDraft(value))
    } catch {
      if (!signal?.aborted) setError('proxyLoadFailed')
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  const change = (channel: keyof ProxyDraft, patch: Partial<ProxyChannelDraft>) => {
    setDraft(current => current === undefined ? current : { ...current, [channel]: { ...current[channel], ...patch } })
    setError(undefined)
    setSaved(false)
  }

  const save = async () => {
    if (draft === undefined || settings === undefined) return
    let value: ProxySettingsSnapshot
    try { value = proxyDraftSettings(draft, settings.revision) } catch {
      setError('proxyInvalid')
      return
    }
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const response = await fetch(PROXY_SETTINGS_PATH, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      })
      if (response.status === 409) { setError('proxyConflict'); return }
      if (!response.ok) throw new Error('Settings save failed')
      const updated = parseProxySettings(await response.json())
      setSettings(updated)
      setDraft(proxyDraft(updated))
      setSaved(true)
    } catch { setError('proxySaveFailed') } finally { setBusy(false) }
  }

  const dirty = settings !== undefined && draft !== undefined
    && JSON.stringify(draft) !== JSON.stringify(proxyDraft(settings))
  return (
    <section className="dsh-pi-login-card dsh-oauth-network" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="dsh-pi-login-name">{t('proxyTitle')}</h3>
      <p className="dsh-pi-login-body">{t('proxyScope')}</p>
      {draft === undefined && busy ? <p className="dsh-pi-login-body">{t('proxyLoading')}</p> : null}
      {draft === undefined ? null : (['http', 'websocket'] as const).map(channel => (
        <fieldset className="dsh-oauth-proxy-channel" key={channel} disabled={busy}>
          <legend className="dsh-pi-login-name">{channel === 'http' ? 'HTTP / HTTPS' : 'WebSocket (WS / WSS)'}</legend>
          <label className="dsh-oauth-proxy-switch" htmlFor={`${id}-${channel}-enabled`}>
            <input id={`${id}-${channel}-enabled`} type="checkbox" role="switch"
              checked={draft[channel].enabled}
              onChange={event => change(channel, { enabled: event.currentTarget.checked })} />
            {t(channel === 'http' ? 'proxyHttpEnabled' : 'proxyWsEnabled')}
          </label>
          <p className="dsh-pi-login-body">{t(channel === 'http' ? 'proxyHttpHelp' : 'proxyWsHelp')}</p>
          <div className="dsh-oauth-proxy-fields">
            <label htmlFor={`${id}-${channel}-address`}>
              <span>{t('proxyAddress')}</span>
              <input className="dsh-pi-login-input" id={`${id}-${channel}-address`}
                autoComplete="off" spellCheck={false} placeholder={DEFAULT_PROXY_ADDRESS}
                value={draft[channel].address} disabled={!draft[channel].enabled}
                onChange={event => change(channel, { address: event.currentTarget.value })} />
            </label>
            <label htmlFor={`${id}-${channel}-port`}>
              <span>{t('proxyPort')}</span>
              <input className="dsh-pi-login-input" id={`${id}-${channel}-port`}
                autoComplete="off" inputMode="numeric" placeholder={t('proxyPortPlaceholder')}
                value={draft[channel].port} disabled={!draft[channel].enabled}
                onChange={event => change(channel, { port: event.currentTarget.value })} />
            </label>
          </div>
          <p className="dsh-pi-login-body">{t(!draft[channel].enabled ? 'proxyDirect'
            : isAutomaticProxyDraft(draft[channel]) ? 'proxyAuto' : 'proxyExplicit')}</p>
        </fieldset>
      ))}
      <p className="dsh-pi-login-body">{t('proxyApplyHelp')}</p>
      <div aria-live="polite">
        {error === undefined ? null : <p className="dsh-pi-login-error" role="alert">{t(error)}</p>}
        {saved ? <p className="dsh-pi-login-body">{t('proxySaved')}</p> : null}
      </div>
      <div className="dsh-pi-login-row dsh-oauth-proxy-actions">
        <button type="button" className="dsh-pi-login-btn dsh-pi-login-btn-secondary" disabled={busy}
          onClick={() => { void load() }}>{t('proxyReload')}</button>
        <button type="button" className="dsh-pi-login-btn dsh-pi-login-btn-primary"
          disabled={busy || !dirty} onClick={() => { void save() }}>{t(busy ? 'working' : 'proxySave')}</button>
      </div>
    </section>
  )
}
