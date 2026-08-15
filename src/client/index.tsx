/** Browser half: Pi login inside dsh Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PiLoginSettings } from './PiLoginSettings.tsx'
import type { PiLoginSettingsInjected } from './PiLoginSettings.tsx'
import { en, zh } from './locales.ts'
import type { PiLoginKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pi-login': PiLoginKey
  }
}

export const name = 'dsh-pi-login-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.pi-login'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-pi-login: settings copy')
  const t = ctx.locale.bind(namespace) as PiLoginSettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pi-login',
    order: 17,
    label: () => t('nav'),
    inject: (): PiLoginSettingsInjected => ({ t }),
  }, PiLoginSettings))
}
