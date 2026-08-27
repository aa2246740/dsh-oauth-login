/** Browser half: Pi login settings page + searchable composer model seat. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PiLoginSettings } from './PiLoginSettings.tsx'
import type { PiLoginSettingsInjected } from './PiLoginSettings.tsx'
import { SearchableModelSelect } from './SearchableModelSelect.tsx'
import { en, zh, searchEn, searchZh } from './locales.ts'
import type { PiLoginKey, ModelSearchKey } from './locales.ts'
import { OpenRouterCatalogClient } from './openrouter-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pi-login': PiLoginKey
    /** Host-owned dictionary (registered by ui-model-selection); keys stay open here. */
    model: string
    'model-search': ModelSearchKey
  }
  interface SlotMap {
    /**
     * Local mirror of ui-conversation's composer model seat so this package
     * compiles standalone; the runtime declaration lives in the host.
     */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: { locked: boolean } }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Local structural mirror of ui-model-selection's ModelDirectoryResolver
     * so this package compiles standalone; the runtime service lives in the
     * host client bundle and is instantiated on first access.
     */
    modelDirectories: {
      directoryFor(sessionId: string): {
        store: import('./SearchableModelSelect.tsx').SnapshotStoreOf
        load(): Promise<unknown>
        select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
      }
    }
  }
}

export const name = 'dsh-oauth-login-client'
export const inject = ['slots', 'locale', 'sessions', 'modelDirectories']

export function apply(ctx: ClientContext): void {
  const catalog = new OpenRouterCatalogClient()
  ctx.effect(() => () => catalog.dispose(), 'dsh-oauth-login: catalog metadata')
  const searchNs = 'model-search'
  ctx.effect(() => ctx.locale.register(searchNs, { zh: searchZh, en: searchEn }), 'dsh-oauth-login: model-search copy')
  const ts = ctx.locale.bind(searchNs) as (key: string, params?: Record<string, unknown>) => string
  const namespace = 'settings.pi-login'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-oauth-login: settings copy')
  const t = ctx.locale.bind(namespace) as PiLoginSettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pi-login',
    order: 17,
    label: () => t('nav'),
    inject: (): PiLoginSettingsInjected => ({ t, ts, catalog }),
  }, PiLoginSettings))

  // Searchable shadow of the composer model seat. Priority -1 renders over
  // the shipped ModelSelect (priority 0, lowest live entry wins); removing
  // this plugin restores the stock selector with no host restart.
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model',
    locale: 'model',
    priority: -1,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      const available = ctx.sessions.subagentAddress(sessionId) === undefined
      return {
        available,
        catalog,
        directory: directory.store,
        load: () => {
          if (available) directory.load().catch(() => { /* surfaced on the store */ })
        },
        select: (selection: { provider: string; model: string; reasoningEffort?: string }) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
        ts,
      }
    },
  }, SearchableModelSelect))
}
