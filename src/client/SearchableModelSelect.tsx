/**
 * SearchableModelSelect: plugin-owned shadow of the composer model seat
 * (`conversation.input.model`, registered at priority -1 so it renders over
 * the shipped ModelSelect). Behavior mirrors the official two-level menu —
 * root rows drill into the model list and the effort list over the SAME
 * shared per-session directory — and adds one thing the shipped seat lacks:
 * a local search box on the model pane that filters provider groups by model
 * name/id or provider name while typing. Selection still submits through the
 * injected `select` face, so the host stays the single fact source.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelDirectoryState as DirectoryState, ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { filterGroups } from './model-filter.ts'
import type { FilterGroup } from './model-filter.ts'
import type { OpenRouterCatalogClient } from './openrouter-store.ts'
import { OpenRouterSyncStatus } from './OpenRouterSyncStatus.tsx'
import { OPENROUTER_ROUTE } from '../openrouter-types.ts'

/** Which pane the dropdown shows. */
type Pane = 'root' | 'model' | 'effort'

/** One effort row; undefined effort preserves the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** Component props: owner share + injected face + both translators. */
export interface SearchableModelSelectInjected extends ModelSelectInjected {
  catalog: OpenRouterCatalogClient
  /** Plugin `model-search` namespace translate (search box copy). */
  ts: TranslateNS<'model-search'>
}

export type SearchableModelSelectProps = PropsRuntime<'conversation.input.model'>
  & PropsLocale<'model'>
  & InjectFace<SearchableModelSelectInjected>

const STYLE_ID = 'dsh-oauth-model-search-theme'

/** Theme-token styles mirroring the shipped seat's menu vocabulary. */
const SEARCH_CSS = `
.dsh-oauth-ms-root { position:relative; min-width:0; }
.dsh-oauth-ms-trigger {
  display:flex; align-items:center; gap:4px; min-width:0;
  max-width:min(360px,45cqw); height:28px; padding:0 4px 0 8px;
  border:none; border-radius:24px; outline:none; background:transparent;
  color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px;
  font-weight:500; cursor:pointer;
}
.dsh-oauth-ms-trigger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-oauth-ms-trigger:focus-visible { box-shadow:0 0 0 2px var(--dsw-alias-border-l3); }
.dsh-oauth-ms-trigger:disabled { color:var(--dsw-alias-label-dimmed); cursor:default; }
.dsh-oauth-ms-triggerLabel { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-oauth-ms-triggerEffort { flex:0 0 auto; color:var(--dsw-alias-label-caption); }
.dsh-oauth-ms-chevron { flex:0 0 auto; color:var(--dsw-alias-label-caption); transition:transform 120ms ease; }
.dsh-oauth-ms-chevronOpen { transform:rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .dsh-oauth-ms-chevron { transition:none; } }
.dsh-oauth-ms-menu {
  position:absolute; right:0; bottom:calc(100% + 8px); z-index:20;
  display:flex; flex-direction:column;
  width:max-content; min-width:min(240px,calc(100vw - 32px));
  max-width:min(420px,calc(100vw - 32px));
  max-height:min(360px,calc(100vh - 96px)); overflow:hidden; padding:4px;
  border:1px solid var(--dsw-alias-border-inverted); border-radius:12px;
  background:var(--dsw-specific-menu); box-shadow:var(--dsw-shadow-lv3);
  color:var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-oauth-ms-status,.dsh-oauth-ms-empty { padding:10px; color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:20px; }
.dsh-oauth-ms-errorStrip {
  display:flex; align-items:flex-start; justify-content:space-between; gap:8px;
  margin-bottom:4px; padding:7px 8px; border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover-danger);
  color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:18px;
}
.dsh-oauth-ms-warning {
  display:flex; align-items:flex-start; justify-content:space-between; gap:8px;
  margin-bottom:4px; padding:7px 8px; border-radius:8px;
  background:var(--dsw-alias-bg-module-platform);
  color:var(--dsw-alias-state-warn-label); font-size:12px; line-height:18px;
}
.dsh-oauth-ms-retry { flex:0 0 auto; padding:0; border:none; background:transparent; color:inherit; font:inherit; font-weight:600; cursor:pointer; }
.dsh-oauth-ms-search {
  margin:2px 2px 4px; padding:6px 8px; border:1px solid var(--dsw-alias-border-inverted);
  border-radius:8px; background:transparent; font-size:13px;
  color:var(--dsw-alias-label-primary); outline:none;
}
.dsh-oauth-ms-search:focus-visible { box-shadow:0 0 0 2px var(--dsw-alias-border-l3); }
.dsh-oauth-ms-groups { min-height:0; overflow-y:auto; }
.dsh-oauth-ms-group + .dsh-oauth-ms-group { margin-top:4px; }
.dsh-oauth-ms-groupTitle {
  position:sticky; top:0; z-index:1; padding:5px 8px 3px;
  background:var(--dsw-specific-menu); color:var(--dsw-alias-label-tertiary);
  font-size:12px; line-height:18px; font-weight:500;
}
.dsh-oauth-ms-option {
  box-sizing:border-box; display:flex; align-items:center; gap:8px;
  width:auto; min-width:100%; min-height:38px; padding:6px 8px;
  border:none; border-radius:10px; outline:none; background:transparent;
  color:inherit; text-align:left; cursor:pointer;
}
.dsh-oauth-ms-option:hover:not(:disabled),.dsh-oauth-ms-option:focus-visible { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-oauth-ms-option:disabled { color:var(--dsw-alias-label-dimmed); cursor:default; }
.dsh-oauth-ms-optionCopy { display:flex; flex:1; flex-direction:column; min-width:0; }
.dsh-oauth-ms-modelName { overflow:hidden; color:inherit; font-size:14px; line-height:20px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
.dsh-oauth-ms-description { overflow:hidden; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-oauth-ms-check { display:grid; place-items:center; flex:0 0 18px; color:var(--dsw-alias-label-primary); }
.dsh-oauth-ms-cell {
  box-sizing:border-box; display:flex; align-items:center; gap:8px;
  width:auto; min-width:100%; height:40px; padding:0 10px;
  border:none; border-radius:10px; background:transparent;
  color:var(--dsw-alias-label-primary); font-size:14px; line-height:22px;
  cursor:pointer; text-align:left;
}
.dsh-oauth-ms-cell:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-oauth-ms-cellLabel { flex:0 0 auto; white-space:nowrap; }
.dsh-oauth-ms-cellValue { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; color:var(--dsw-alias-label-tertiary); }
.dsh-oauth-ms-cellChevron { flex:0 0 auto; color:var(--dsw-alias-label-tertiary); }
.dsh-oauth-ms-filters { display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:2px 4px 4px; }
.dsh-oauth-ms-filter { min-height:28px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer; }
.dsh-oauth-ms-filter[aria-pressed="true"] { background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3); }
.dsh-oauth-ms-filter:focus-visible { outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px; }
.dsh-oauth-ms-meta { display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px; }
.dsh-oauth-ms-free { padding:1px 6px;border-radius:4px;color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent); }
.dsh-oauth-ms-cached { color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover); }
.dsh-oauth-ms-ended { color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 50%,var(--dsw-alias-label-primary));white-space:normal; }
.dsh-oauth-ms-help { padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:normal; }
@media (max-width:480px) { .dsh-oauth-ms-menu { width:calc(100vw - 32px);max-height:min(520px,calc(100dvh - 120px)); } .dsh-oauth-ms-option { min-height:44px; } }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    existing.textContent = SEARCH_CSS
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = SEARCH_CSS
  document.head.appendChild(style)
}

/** Small inline chevron-down glyph (avoids importing host primitives). */
function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Small inline chevron-right glyph. */
function ChevronRight({ className }: { className: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Render the searchable composer model seat.
 * @param props - see {@link SearchableModelSelectProps}.
 * @returns the trigger and, while open, the search-enabled two-level menu.
 */
export function SearchableModelSelect(
  { locked, available, directory, catalog, load, select, t, ts }: SearchableModelSelectProps,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  ) as DirectoryState
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const metadata = useMemo(() => new Map(catalogState.data?.models.map(model => [model.id, model]) ?? []), [catalogState.data])
  const freeModels = useMemo(() => new Set([...metadata.values()].filter(model => model.priceStatus === 'free').map(model => model.id)), [metadata])
  const [freeOnly, setFreeOnly] = useState(false)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [notice, setNotice] = useState<{ seq: number; text: string } | null>(null)
  const noticeSeq = useRef(0)
  const noticeTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  useEffect(() => { ensureStyles() }, [])
  useEffect(() => {
    if (open && pane === 'model') searchRef.current?.focus()
  }, [open, pane])
  useEffect(() => {
    if (catalogState.data?.connected === false) setFreeOnly(false)
  }, [catalogState.data?.connected])
  useEffect(() => {
    if (available && catalogState.data?.lastUpdatedAt != null) load()
  }, [available, catalogState.data?.lastUpdatedAt, load])
  useEffect(() => () => { window.clearTimeout(noticeTimer.current) }, [])

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const current = state.current
  const selectedIndex = current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === current.provider && c.selection.model === current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map(effort => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const filteredGroups = useMemo<readonly FilterGroup[]>(
    () => filterGroups(state.groups, query, freeOnly ? freeModels : undefined),
    [state.groups, query, freeOnly, freeModels])
  const filteredCount = useMemo(
    () => filteredGroups.reduce((sum, group) => sum + group.models.length, 0),
    [filteredGroups])

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
    void catalog.load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setQuery('')
    setNotice(null)
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    setQuery('')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null && !item.disabled)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      noticeSeq.current += 1
      window.clearTimeout(noticeTimer.current)
      setNotice({ seq: noticeSeq.current, text: t('error.action', { message }) })
      noticeTimer.current = window.setTimeout(() => { setNotice(null) }, 4000)
    }
  }

  const choose = (selection: ModelSelection): void => {
    const info = selection.provider === OPENROUTER_ROUTE ? metadata.get(selection.model) : undefined
    if (info?.freeOnly && info.priceStatus !== 'free') return
    const current = state.current
    if (current?.provider === selection.provider && current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  /** Search-input keyboard: ↓ enters the list, Enter picks the first match, Escape clears then backs out. */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      itemRefs.current.find(item => item !== null)?.focus()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = filteredGroups[0]?.models[0]
      if (first !== undefined) choose({ provider: filteredGroups[0].id, model: first.id })
      return
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (query !== '') setQuery('')
      // Non-Escape propagation lets the root handler back out of the pane.
    }
  }

  const modelLabel = currentChoice?.model.name ?? state.current?.model ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className="dsh-oauth-ms-root" onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-oauth-ms-trigger"
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) close()
          else show()
        }}
      >
        <span className="dsh-oauth-ms-triggerLabel">{modelLabel}</span>
        {effortLabel !== undefined && <span className="dsh-oauth-ms-triggerEffort">{effortLabel}</span>}
        <Chevron className={`dsh-oauth-ms-chevron${open ? ' dsh-oauth-ms-chevronOpen' : ''}`} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className="dsh-oauth-ms-menu"
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className="dsh-oauth-ms-cell" onClick={() => { setPane('model') }}>
                <span className="dsh-oauth-ms-cellLabel">{t('menu.model')}</span>
                <span className="dsh-oauth-ms-cellValue">{modelLabel}</span>
                <ChevronRight className="dsh-oauth-ms-cellChevron" />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className="dsh-oauth-ms-cell" onClick={() => { setPane('effort') }}>
                  <span className="dsh-oauth-ms-cellLabel">{t('menu.effort')}</span>
                  <span className="dsh-oauth-ms-cellValue">{effortLabel}</span>
                  <ChevronRight className="dsh-oauth-ms-cellChevron" />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              <input
                ref={searchRef}
                type="text"
                className="dsh-oauth-ms-search"
                placeholder={ts('placeholder')}
                aria-label={ts('aria')}
                value={query}
                autoComplete="off"
                spellCheck={false}
                onChange={event => { setQuery(event.target.value) }}
                onKeyDown={onSearchKeyDown}
              />
              {(catalogState.data?.connected || state.groups.some(group => group.id === OPENROUTER_ROUTE)) && <>
                <div className="dsh-oauth-ms-filters" role="group" aria-label={ts('freeFilterAria')}>
                  <button type="button" className="dsh-oauth-ms-filter" aria-pressed={!freeOnly} onClick={() => { setFreeOnly(false) }}>{ts('all')}</button>
                  <button type="button" className="dsh-oauth-ms-filter" aria-pressed={freeOnly} onClick={() => { setFreeOnly(true) }}>{ts('freeOnly')} · {freeModels.size}</button>
                </div>
                <OpenRouterSyncStatus catalog={catalog} ts={ts} />
              </>}
              {state.status === 'loading' && <div className="dsh-oauth-ms-status">{t('status.loading')}</div>}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className="dsh-oauth-ms-errorStrip">
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className="dsh-oauth-ms-retry" onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className="dsh-oauth-ms-warning" key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className="dsh-oauth-ms-retry" onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className="dsh-oauth-ms-groups">
                {filteredGroups.map((group) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className="dsh-oauth-ms-group" key={group.id}>
                      <div className="dsh-oauth-ms-groupTitle" id={headingId}>{group.name}</div>
                      {group.models.map(model => {
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        const info = group.id === OPENROUTER_ROUTE ? metadata.get(model.id) : undefined
                        const blocked = info?.freeOnly === true && info.priceStatus !== 'free'
                        const tokens = info === undefined ? '' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(info.contextWindow)
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            className="dsh-oauth-ms-option"
                            key={model.id}
                            title={model.name}
                            disabled={busy || blocked}
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
                          >
                            <span className="dsh-oauth-ms-optionCopy">
                              <span className="dsh-oauth-ms-modelName">{model.name}</span>
                              {model.description !== undefined && (
                                <span className="dsh-oauth-ms-description">{model.description}</span>
                              )}
                              {info !== undefined && (
                                <span className="dsh-oauth-ms-meta">
                                  {info.priceStatus === 'free' && <span className={'dsh-oauth-ms-free' + (catalogState.data?.stale ? ' dsh-oauth-ms-cached' : '')}>
                                    {ts(catalogState.data?.stale ? 'freeCached' : 'free')}
                                  </span>}
                                  {blocked && <span className="dsh-oauth-ms-ended">{ts(info.priceStatus === 'paid' ? 'freeEnded' : 'freeUnknown')}</span>}
                                  <span>{ts(info.tools ? 'tools' : 'chatOnly')}</span>
                                  <span>{ts('context', { tokens })}</span>
                                </span>
                              )}
                            </span>
                            <span className="dsh-oauth-ms-check">
                              {selected
                                ? (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                      <path d="M3 8.5l3.2 3L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  )
                                : null}
                            </span>
                          </button>
                        )
                      })}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && state.groups.length > 0 && filteredCount === 0 && (
                <div className="dsh-oauth-ms-empty">{freeOnly ? ts('emptyFree') : ts('empty', { query: query.trim() })}</div>
              )}
              {state.status === 'ready' && state.groups.length === 0 && (
                <div className="dsh-oauth-ms-empty">{t('empty.models')}</div>
              )}
              {freeOnly && <div className="dsh-oauth-ms-help">{ts('freeHelp')}</div>}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className="dsh-oauth-ms-errorStrip">
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className="dsh-oauth-ms-retry" onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className="dsh-oauth-ms-empty">{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className="dsh-oauth-ms-option"
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className="dsh-oauth-ms-optionCopy">
                      <span className="dsh-oauth-ms-modelName">{level.label}</span>
                      {level.description !== undefined && (
                        <span className="dsh-oauth-ms-description">{level.description}</span>
                      )}
                    </span>
                    <span className="dsh-oauth-ms-check">
                      {effectiveEffort === level.effort
                        ? (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path d="M3 8.5l3.2 3L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )
                        : null}
                    </span>
                  </button>
                ))}
            </>
          )}

          {notice !== null && (
            <div role="alert" className="dsh-oauth-ms-errorStrip" key={notice.seq}>{notice.text}</div>
          )}
        </div>
      )}
    </div>
  )
}
