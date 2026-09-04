/** Browser half: Pi login settings page + searchable composer model seat. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { PiLoginSettings } from './PiLoginSettings.tsx'
import type { PiLoginSettingsInjected } from './PiLoginSettings.tsx'
import { SearchableModelSelect } from './SearchableModelSelect.tsx'
import { en, zh, searchEn, searchZh } from './locales.ts'
import type { PiLoginKey, ModelSearchKey } from './locales.ts'
import { OpenRouterCatalogClient } from './openrouter-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pi-login': PiLoginKey
    'model-search': ModelSearchKey
  }
}

export const name = 'dsh-oauth-login-client'
export const inject = ['slots', 'locale', 'sessions', 'modelDirectories']

export function apply(ctx: ClientContext): void {
  const catalog = new OpenRouterCatalogClient()
  ctx.effect(() => () => catalog.dispose(), 'dsh-oauth-login: catalog metadata')
  const searchNs = 'model-search'
  ctx.effect(() => ctx.locale.register(searchNs, { zh: searchZh, en: searchEn }), 'dsh-oauth-login: model-search copy')
  const ts = ctx.locale.bind(searchNs)
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
        select: (selection: ModelSelection) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
        ts,
      }
    },
  }, SearchableModelSelect))
}
