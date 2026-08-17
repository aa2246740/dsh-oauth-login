/** Plugin-owned Pi login page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import type { PiLoginKey } from './locales.ts'

const STATUS_PATH = '/plugins/dsh-pi-login/auth/status'
const LOGIN_PATH = '/plugins/dsh-pi-login/auth/login'
const LOGOUT_PATH = '/plugins/dsh-pi-login/auth/logout'
const POLL_INTERVAL_MS = 1_000
const STYLE_ID = 'dsh-pi-login-settings-theme'

type AccountState =
  | { status: 'signed-out' }
  | { status: 'signing-in'; url?: string; userCode?: string }
  | { status: 'signed-in'; models?: string[]; expiresAt?: string }
  | { status: 'error'; message: string }

interface ProviderStatus {
  id: string
  route: string
  displayName: string
  shortName: string
  account: AccountState
}

interface LoginChallenge {
  provider: string
  url: string
  userCode?: string
}

export interface PiLoginSettingsInjected {
  t: (key: PiLoginKey, params?: Record<string, unknown>) => string
}

export type PiLoginSettingsProps = Partial<PiLoginSettingsInjected>

/**
 * Theme tokens that track light/dark. Hardcoded white/layer fills break dark mode.
 * Mirrors ModelsSection button vocabulary so OAuth cards match the rest of Settings.
 */
const SETTINGS_CSS = `
.dsh-pi-login-page { display:flex; flex-direction:column; gap:18px; max-width:760px; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-title { margin:0; font-size:20px; line-height:28px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-body { margin:0; font-size:14px; line-height:22px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-body-tight { margin:6px 0 0; font-size:14px; line-height:22px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-error { margin:0; font-size:14px; line-height:22px; color:var(--dsw-alias-state-error-primary); }
.dsh-pi-login-stack { display:flex; flex-direction:column; gap:12px; }
.dsh-pi-login-card {
  display:flex; flex-direction:column; gap:12px; padding:16px 18px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-module-platform);
}
.dsh-pi-login-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.dsh-pi-login-name { margin:0; font-size:16px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-status { display:flex; align-items:center; gap:9px; font-size:15px; font-weight:500; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-pi-login-dot.is-signed-in { background:var(--dsw-alias-state-success-primary, #22a06b); }
.dsh-pi-login-dot.is-error { background:var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-pi-login-dot.is-signing-in { background:var(--dsw-alias-brand-primary, #1677ff); }
.dsh-pi-login-btn {
  box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  min-height:34px; padding:6px 14px; border-radius:18px; font:inherit; font-size:14px; line-height:22px; cursor:pointer;
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
  font-size:20px; letter-spacing:0.08em; font-weight:600; color:var(--dsw-alias-label-primary);
}
.dsh-pi-login-link { color:var(--dsw-alias-brand-primary); word-break:break-all; }
.dsh-pi-login-list { display:flex; flex-wrap:wrap; gap:8px; margin:0; padding:0; list-style:none; }
.dsh-pi-login-chip {
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:12px; padding:4px 8px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);
}
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

export function PiLoginSettings({ t }: PiLoginSettingsProps) {
  if (t === undefined) throw new Error('Pi login settings requires its translation function')
  const [providers, setProviders] = useState<ProviderStatus[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  useEffect(() => { ensureThemeStyles() }, [])

  const refresh = useCallback(async () => {
    try {
      setProviders(await jsonRequest<ProviderStatus[]>(STATUS_PATH))
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    }
  }, [t])

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
      if (popup === null) {
        await refresh()
        return
      }
      popup.location.replace(challenge.url)
      await refresh()
    } catch (caught: unknown) {
      popup?.close()
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
      <div>
        <h2 id="pi-login-settings-title" className="dsh-pi-login-title">{t('title')}</h2>
        <p className="dsh-pi-login-body-tight">{t('intro')}</p>
      </div>
      {error !== undefined ? <p className="dsh-pi-login-error">{error}</p> : null}
      {providers === undefined
        ? <p className="dsh-pi-login-body">{t('loadingAccount')}</p>
        : (
            <div className="dsh-pi-login-stack">
              {providers.map(provider => {
                const account = provider.account
                const label = account.status === 'signed-in'
                  ? t('signedIn')
                  : account.status === 'signing-in'
                    ? t('signingIn')
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
                      <div>
                        <p className="dsh-pi-login-name">{provider.displayName}</p>
                        <p className="dsh-pi-login-body">{t('route')} <code>{provider.route}</code></p>
                      </div>
                      <div className="dsh-pi-login-status" role="status">
                        <span aria-hidden="true" className={dotClass} />
                        <span>{label}</span>
                      </div>
                    </div>
                    <div>
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
                              {busy === provider.id ? t('working') : account.status === 'error' ? t('loginAgain') : t('login')}
                            </button>
                          )}
                    </div>
                    {account.status === 'error' ? <p className="dsh-pi-login-error">{account.message}</p> : null}
                    {account.status === 'signed-in' && account.expiresAt !== undefined
                      ? <p className="dsh-pi-login-body">{t('expires')} {new Date(account.expiresAt).toLocaleString()}</p>
                      : null}
                    {account.status === 'signed-in'
                      ? (
                          <ul className="dsh-pi-login-list">
                            {(account.models ?? []).slice(0, 12).map(id => (
                              <li key={id} className="dsh-pi-login-chip">{id}</li>
                            ))}
                          </ul>
                        )
                      : null}
                    {account.status === 'signing-in' && account.userCode !== undefined
                      ? <p className="dsh-pi-login-body">{t('userCode')} <span className="dsh-pi-login-code">{account.userCode}</span></p>
                      : null}
                    {account.status === 'signing-in' && account.url !== undefined
                      ? (
                          <p className="dsh-pi-login-body">
                            {t('openUrl')}
                            {' '}
                            <a href={account.url} target="_blank" rel="noreferrer" className="dsh-pi-login-link">{account.url}</a>
                          </p>
                        )
                      : null}
                  </article>
                )
              })}
            </div>
          )}
      <p className="dsh-pi-login-body">{t('isolation')}</p>
      <p className="dsh-pi-login-body">{t('modelHint')}</p>
    </section>
  )
}
