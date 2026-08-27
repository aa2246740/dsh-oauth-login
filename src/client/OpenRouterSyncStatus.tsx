import { useEffect, useState, useSyncExternalStore } from 'react'
import type { OpenRouterCatalogClient } from './openrouter-store.ts'

const CSS = [
  '.dsh-or-sync{display:flex;flex-direction:column;gap:4px;padding:6px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}',
  '.dsh-or-sync-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px}',
  '.dsh-or-sync-copy{min-width:0;overflow-wrap:anywhere}',
  '.dsh-or-sync time{font-variant-numeric:tabular-nums}',
  '.dsh-or-refresh{min-height:28px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
  '.dsh-or-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-or-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.dsh-or-refresh:disabled{opacity:.55;cursor:default}',
  '.dsh-or-sync-error{color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 50%,var(--dsw-alias-label-primary))}',
].join('\n')

export interface OpenRouterSyncStatusProps {
  catalog: OpenRouterCatalogClient
  ts: (key: string, params?: Record<string, unknown>) => string
  details?: boolean
}

export function OpenRouterSyncStatus({ catalog, ts, details = false }: OpenRouterSyncStatusProps) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const [now, setNow] = useState(Date.now)
  const data = state.data
  const retryAt = data?.retryAt ?? 0
  useEffect(() => {
    setNow(Date.now())
    if (retryAt <= Date.now()) return
    const timer = setTimeout(() => { setNow(Date.now()) }, retryAt - Date.now() + 20)
    return () => { clearTimeout(timer) }
  }, [retryAt])
  const cooling = retryAt > now
  const working = state.loading || data?.refreshing === true
  const unavailable = state.error !== null || data?.error !== null && data?.error !== undefined
  const timestamp = data?.lastUpdatedAt
  return (
    <div className="dsh-or-sync" data-ud-check={details ? 'openrouter-settings-sync' : 'openrouter-menu-sync'} data-ud-min-gap="4">
      <style>{CSS}</style>
      <div className="dsh-or-sync-row">
        <span className="dsh-or-sync-copy" role="status" aria-live="polite">
          {working ? ts('syncing') : data?.connected ? ts('syncSchedule') : ts('syncSignIn')}
        </span>
        <button type="button" className="dsh-or-refresh"
          disabled={working || cooling || data?.connected !== true}
          onClick={() => { void catalog.load(true) }}
        >{working ? ts('syncing') : cooling ? ts('syncCooldown') : ts('syncRefresh')}</button>
      </div>
      {timestamp != null && (
        <span className="dsh-or-sync-copy">{ts('syncUpdated')}{' '}
          <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleString()}</time>
          {data?.stale ? ' · ' + ts('syncStale') : ''}
        </span>
      )}
      {timestamp == null && data?.connected && <span>{ts('syncBuiltin')}</span>}
      {unavailable && <span role="status" className="dsh-or-sync-copy dsh-or-sync-error">
        {ts(state.error === 'restart' ? 'syncRestart' : data?.error === 'save' ? 'syncSaveError' : 'syncError')}
      </span>}
      {details && <>
        <span>{ts('freeHelp')}</span>
        <span>{ts('forcedPluginWarning')}</span>
      </>}
    </div>
  )
}
