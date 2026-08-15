/** Plugin-owned Pi login page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PiLoginKey } from './locales.ts'

const STATUS_PATH = '/plugins/dsh-pi-login/auth/status'
const LOGIN_PATH = '/plugins/dsh-pi-login/auth/login'
const LOGOUT_PATH = '/plugins/dsh-pi-login/auth/logout'
const POLL_INTERVAL_MS = 1_000

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

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'white' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const codeStyle: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 20, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const linkStyle: CSSProperties = { color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' }
const listStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: 0, padding: 0, listStyle: 'none' }
const chipStyle: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)' }
const nameStyle: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const stackStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }

function dotStyle(status: AccountState['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : status === 'signing-in'
        ? 'var(--dsw-alias-brand-primary, #1677ff)'
        : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
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
    <section style={pageStyle} aria-labelledby="pi-login-settings-title">
      <div>
        <h2 id="pi-login-settings-title" style={titleStyle}>{t('title')}</h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>
      {error !== undefined ? <p style={errorStyle}>{error}</p> : null}
      {providers === undefined
        ? <p style={bodyStyle}>{t('loadingAccount')}</p>
        : (
            <div style={stackStyle}>
              {providers.map(provider => {
                const account = provider.account
                const label = account.status === 'signed-in'
                  ? t('signedIn')
                  : account.status === 'signing-in'
                    ? t('signingIn')
                    : account.status === 'error'
                      ? t('requestFailed')
                      : t('signedOut')
                return (
                  <article key={provider.id} style={cardStyle}>
                    <div style={rowStyle}>
                      <div>
                        <p style={nameStyle}>{provider.displayName}</p>
                        <p style={bodyStyle}>{t('route')} <code>{provider.route}</code></p>
                      </div>
                      <div style={statusStyle} role="status">
                        <span aria-hidden="true" style={dotStyle(account.status)} />
                        <span>{label}</span>
                      </div>
                    </div>
                    <div>
                      {account.status === 'signed-in'
                        ? <button type="button" style={buttonStyle} disabled={busy !== undefined} onClick={() => { void signOut(provider.id) }}>{busy === provider.id ? t('working') : t('logout')}</button>
                        : (
                            <button type="button" style={primaryButtonStyle} disabled={busy !== undefined} onClick={() => { void signIn(provider.id) }}>
                              {busy === provider.id ? t('working') : account.status === 'error' ? t('loginAgain') : t('login')}
                            </button>
                          )}
                    </div>
                    {account.status === 'error' ? <p style={errorStyle}>{account.message}</p> : null}
                    {account.status === 'signed-in' && account.expiresAt !== undefined
                      ? <p style={bodyStyle}>{t('expires')} {new Date(account.expiresAt).toLocaleString()}</p>
                      : null}
                    {account.status === 'signed-in'
                      ? (
                          <ul style={listStyle}>
                            {(account.models ?? []).slice(0, 12).map(id => (
                              <li key={id} style={chipStyle}>{id}</li>
                            ))}
                          </ul>
                        )
                      : null}
                    {account.status === 'signing-in' && account.userCode !== undefined
                      ? <p style={bodyStyle}>{t('userCode')} <span style={codeStyle}>{account.userCode}</span></p>
                      : null}
                    {account.status === 'signing-in' && account.url !== undefined
                      ? (
                          <p style={bodyStyle}>
                            {t('openUrl')}
                            {' '}
                            <a href={account.url} target="_blank" rel="noreferrer" style={linkStyle}>{account.url}</a>
                          </p>
                        )
                      : null}
                  </article>
                )
              })}
            </div>
          )}
      <p style={bodyStyle}>{t('isolation')}</p>
      <p style={bodyStyle}>{t('modelHint')}</p>
    </section>
  )
}
