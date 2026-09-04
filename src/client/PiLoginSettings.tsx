/** Plugin-owned Pi login page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import { applyDraftChange } from './draft-input.ts'
import type { Drafts } from './draft-input.ts'
import type { PiLoginKey } from './locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenRouterCatalogClient } from './openrouter-store.ts'
import { OpenRouterSyncStatus } from './OpenRouterSyncStatus.tsx'
import { ProxySettings } from './ProxySettings.tsx'
import { loginInputCopy } from './login-input-copy.ts'

const STATUS_PATH = '/plugins/dsh-oauth-login/auth/status'
const LOGIN_PATH = '/plugins/dsh-oauth-login/auth/login'
const COMPLETE_PATH = '/plugins/dsh-oauth-login/auth/complete'
const LOGOUT_PATH = '/plugins/dsh-oauth-login/auth/logout'
const POLL_INTERVAL_MS = 1_000
const STYLE_ID = 'dsh-pi-login-settings-theme'

type AccountState =
  | { status: 'signed-out' }
  | {
    status: 'signing-in'
    kind?: 'browser' | 'input'
    url?: string
    userCode?: string
    input?: LoginInputChallenge
  }
  | { status: 'signed-in'; models?: string[]; expiresAt?: string }
  | { status: 'error'; message: string }

interface LoginInputChallenge {
  type: 'secret' | 'text' | 'manual_code'
  message: string
  placeholder?: string
}

interface ProviderStatus {
  id: string
  route: string
  displayName: string
  shortName: string
  authType: 'oauth' | 'api_key'
  account: AccountState
}

interface LoginChallenge {
  provider: string
  kind: 'browser' | 'input'
  url?: string
  userCode?: string
  input?: LoginInputChallenge
}

export interface PiLoginSettingsInjected {
  t: (key: PiLoginKey, params?: Record<string, unknown>) => string
  ts: TranslateNS<'model-search'>
  catalog: OpenRouterCatalogClient
}

export type PiLoginSettingsProps = Partial<PiLoginSettingsInjected>

/**
 * Theme tokens that track light/dark. Hardcoded white/layer fills break dark mode.
 * Mirrors ModelsSection button vocabulary so OAuth cards match the rest of Settings.
 */
const SETTINGS_CSS = `
.dsh-pi-login-page { display:flex; flex-direction:column; gap:16px; max-width:640px; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-title { margin:0; font-size:20px; line-height:28px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-body { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-error { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-state-error-primary); }
.dsh-pi-login-stack { display:flex; flex-direction:column; gap:10px; }
.dsh-pi-login-card {
  display:flex; flex-direction:column; gap:8px; padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-module-platform);
}
.dsh-pi-login-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.dsh-pi-login-name { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-status { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-pi-login-dot.is-signed-in { background:var(--dsw-alias-state-success-primary, #22a06b); }
.dsh-pi-login-dot.is-error { background:var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-pi-login-dot.is-signing-in { background:var(--dsw-alias-brand-primary, #1677ff); }
.dsh-pi-login-btn {
  box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  min-height:32px; padding:4px 14px; border-radius:16px; font:inherit; font-size:13px; line-height:20px; cursor:pointer;
}
.dsh-pi-login-btn:disabled { opacity:0.55; cursor:not-allowed; }
.dsh-pi-login-btn-secondary {
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
}
.dsh-pi-login-btn-secondary:hover:not(:disabled) {
  background:var(--dsw-alias-interactive-bg-hover);
}
.dsh-pi-login-btn-primary {
  border:none;
  background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-pi-login-btn-primary:hover:not(:disabled) {
  background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
}
.dsh-pi-login-code {
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:18px; letter-spacing:0.08em; font-weight:600; color:var(--dsw-alias-label-primary);
}
.dsh-pi-login-link { color:var(--dsw-alias-brand-primary); word-break:break-all; }
.dsh-pi-login-form { display:flex; flex-direction:column; gap:8px; }
.dsh-pi-login-input {
  box-sizing:border-box; width:100%; min-height:36px; padding:7px 10px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
  background:var(--dsw-alias-bg-page-primary, transparent);
  color:var(--dsw-alias-label-primary); font:inherit; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-pi-login-input:focus {
  outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent);
  border-color:var(--dsw-alias-brand-primary);
}
.dsh-pi-login-actions { display:flex; justify-content:flex-end; }
.dsh-oauth-proxy-channel { min-width:0; margin:8px 0 0; padding:12px 0 0; border:0; border-top:1px solid var(--dsw-alias-border-l2); display:flex; flex-direction:column; gap:8px; }
.dsh-oauth-proxy-channel legend { padding:0 8px 0 0; font-size:13px; }
.dsh-oauth-proxy-switch { display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; }
.dsh-oauth-proxy-switch input { width:16px; height:16px; margin:0; accent-color:var(--dsw-alias-brand-primary); }
.dsh-oauth-proxy-fields { display:grid; grid-template-columns:minmax(0, 1fr) 100px; gap:12px; }
.dsh-oauth-proxy-fields label { min-width:0; display:flex; flex-direction:column; gap:6px; font-size:12px; }
.dsh-oauth-proxy-fields input { font-size:13px; }
.dsh-oauth-proxy-fields input:disabled { opacity:0.55; }
.dsh-oauth-proxy-actions { justify-content:flex-end; }
@media (max-width:360px) { .dsh-oauth-proxy-fields { grid-template-columns:minmax(0, 1fr); } }
`

function ensureThemeStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

export function PiLoginSettings({ t, ts, catalog }: PiLoginSettingsProps) {
  if (t === undefined) throw new Error('Pi login settings requires its translation function')
  const [providers, setProviders] = useState<ProviderStatus[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [drafts, setDrafts] = useState<Drafts>({})

  useEffect(() => { ensureThemeStyles() }, [])

  const refresh = useCallback(async () => {
    try {
      setProviders(await jsonRequest<ProviderStatus[]>(STATUS_PATH))
      void catalog?.load()
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    }
  }, [t, catalog])

  useEffect(() => { void refresh() }, [refresh])
  const signing = providers?.some(provider => provider.account.status === 'signing-in') ?? false
  useEffect(() => {
    if (!signing) return
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh, signing])

  const signIn = async (id: string): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setBusy(id)
    try {
      const challenge = await jsonRequest<LoginChallenge>(LOGIN_PATH, 'POST', { provider: id })
      if (popup !== null && challenge.url !== undefined) popup.location.replace(challenge.url)
      if (popup !== null && challenge.url === undefined) popup.close()
      await refresh()
    } catch (caught: unknown) {
      popup?.close()
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const submitInput = async (provider: ProviderStatus): Promise<void> => {
    const value = drafts[provider.id]?.trim() ?? ''
    if (value.length === 0) {
      const challenge = provider.account.status === 'signing-in' ? provider.account.input : undefined
      setError(t(challenge === undefined ? 'authInputRequired' : loginInputCopy(provider.authType, challenge.type).required))
      return
    }
    setBusy(provider.id)
    try {
      await jsonRequest<{ ok: true }>(COMPLETE_PATH, 'POST', { provider: provider.id, value })
      setDrafts(current => {
        const { [provider.id]: _removed, ...next } = current
        return next
      })
      await refresh()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const signOut = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await jsonRequest<{ ok: true }>(LOGOUT_PATH, 'POST', { provider: id })
      await refresh()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="dsh-pi-login-page" aria-labelledby="pi-login-settings-title">
      <h2 id="pi-login-settings-title" className="dsh-pi-login-title">{t('title')}</h2>
      <ProxySettings t={t} />
      {error !== undefined ? <p className="dsh-pi-login-error">{error}</p> : null}
      {providers === undefined
        ? <p className="dsh-pi-login-body">{t('loadingAccount')}</p>
        : (
            <div className="dsh-pi-login-stack">
              {providers.map(provider => {
                const account = provider.account
                const inputCopy = account.status === 'signing-in' && account.input !== undefined
                  ? loginInputCopy(provider.authType, account.input.type)
                  : undefined
                const label = account.status === 'signed-in'
                  ? t('signedIn')
                  : account.status === 'signing-in'
                    ? inputCopy === undefined ? t('signingIn') : t(inputCopy.waiting)
                    : account.status === 'error'
                      ? t('requestFailed')
                      : t('signedOut')
                const dotClass = account.status === 'signed-in'
                  ? 'dsh-pi-login-dot is-signed-in'
                  : account.status === 'error'
                    ? 'dsh-pi-login-dot is-error'
                    : account.status === 'signing-in'
                      ? 'dsh-pi-login-dot is-signing-in'
                      : 'dsh-pi-login-dot'
                return (
                  <article key={provider.id} className="dsh-pi-login-card">
                    <div className="dsh-pi-login-row">
                      <p className="dsh-pi-login-name">{provider.displayName}</p>
                      {account.status === 'signed-in'
                        ? (
                            <button
                              type="button"
                              className="dsh-pi-login-btn dsh-pi-login-btn-secondary"
                              disabled={busy !== undefined}
                              onClick={() => { void signOut(provider.id) }}
                            >
                              {busy === provider.id ? t('working') : t('logout')}
                            </button>
                          )
                        : (
                            <button
                              type="button"
                              className="dsh-pi-login-btn dsh-pi-login-btn-primary"
                              disabled={busy !== undefined}
                              onClick={() => { void signIn(provider.id) }}
                            >
                              {busy === provider.id
                                ? t('working')
                                : account.status === 'error'
                                  ? t('loginAgain')
                                  : provider.authType === 'api_key'
                                    ? t('connectPlan')
                                    : t('login')}
                            </button>
                          )}
                    </div>
                    <div className="dsh-pi-login-status" role="status">
                      <span aria-hidden="true" className={dotClass} />
                      <span>{label}</span>
                    </div>
                    {provider.id === 'openrouter' && catalog !== undefined && ts !== undefined
                      && <OpenRouterSyncStatus catalog={catalog} ts={ts} details />}
                    {account.status === 'error' ? <p className="dsh-pi-login-error">{account.message}</p> : null}
                    {account.status === 'signing-in' && account.userCode !== undefined
                      ? <p className="dsh-pi-login-body">{t('userCode')} <span className="dsh-pi-login-code">{account.userCode}</span></p>
                      : null}
                    {account.status === 'signing-in' && account.url !== undefined
                      ? (
                          <p className="dsh-pi-login-body">
                            {provider.authType === 'api_key' && account.input !== undefined ? t('openPlanPage') : t('openUrl')}
                            {' '}
                            <a href={account.url} target="_blank" rel="noreferrer" className="dsh-pi-login-link">{account.url}</a>
                          </p>
                        )
                      : null}
                    {account.status === 'signing-in' && account.input !== undefined
                      ? (
                          <form
                            className="dsh-pi-login-form"
                            onSubmit={(event) => {
                              event.preventDefault()
                              void submitInput(provider)
                            }}
                          >
                            <p className="dsh-pi-login-body">{t(inputCopy?.help ?? 'authInputHelp')}</p>
                            <input
                              type={account.input.type === 'secret' ? 'password' : 'text'}
                              className="dsh-pi-login-input"
                              aria-label={account.input.message}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t(inputCopy?.placeholder ?? 'authInputPlaceholder')}
                              value={drafts[provider.id] ?? ''}
                              disabled={busy !== undefined}
                              onChange={(event) => {
                                applyDraftChange(provider.id, event, setDrafts)
                              }}
                            />
                            <div className="dsh-pi-login-actions">
                              <button
                                type="submit"
                                className="dsh-pi-login-btn dsh-pi-login-btn-primary"
                                disabled={busy !== undefined || (drafts[provider.id]?.trim().length ?? 0) === 0}
                              >
                                {busy === provider.id ? t('working') : t(inputCopy?.action ?? 'submitAuthInput')}
                              </button>
                            </div>
                          </form>
                        )
                      : null}
                  </article>
                )
              })}
            </div>
          )}
    </section>
  )
}
