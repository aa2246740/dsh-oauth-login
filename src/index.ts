/**
 * DSH-owned multi-provider OAuth for DeepSeek Harness.
 * Independent store. Never touches Pi Agent or official CLI auth files.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { createPiLoginAdapter } from './adapter.ts'
import { registerPiLoginAuthRoutes } from './auth-routes.ts'
import { piLoginRoutes } from './catalog.ts'
import { PiLoginSession } from './session.ts'
import { PiLoginCredentialStore } from './store.ts'

export { createPiLoginAdapter } from './adapter.ts'
export {
  loginPiProvider,
  loginPiProviderSession,
  logoutPiProvider,
  piLoginStatus,
} from './auth.ts'
export type { PiLoginAuthStatus } from './auth.ts'
export {
  registerPiLoginAuthRoutes,
  PI_LOGIN_AUTH_LOGIN_PATH,
  PI_LOGIN_AUTH_LOGOUT_PATH,
  PI_LOGIN_AUTH_STATUS_PATH,
} from './auth-routes.ts'
export type { LoginChallenge, PiLoginProviderStatus } from './auth-routes.ts'
export { PI_LOGIN_PROVIDERS, piLoginProvider, piLoginRoutes } from './catalog.ts'
export type { PiLoginProvider } from './catalog.ts'
export { extraModelsFor } from './extra-models.ts'
export { LEGACY_PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_FILENAME, PI_LOGIN_ROUTE_PREFIX, PI_LOGIN_STREAM_IDLE_TIMEOUT_MS } from './ids.ts'
export { catalogProvider, harnessModels, harnessProvider, preferredModel } from './provider.ts'
export { isSafeAuthUrl, safeMessage } from './redact.ts'
export { PiLoginSession } from './session.ts'
export { PiLoginCredentialStore, piLoginAuthPath } from './store.ts'

export const name = 'llm-pi-login'
export const inject = ['llm']

export interface Config {}
export const Config: z<Config> = z.object({})

/**
 * Publish only the routes that currently hold an OAuth grant.
 * Logging out must drop that route from the model picker immediately.
 */
async function syncAuthenticatedRoutes(
  session: PiLoginSession,
  registration: AdapterRegistrationHandle,
): Promise<void> {
  registration.replace(await session.authenticatedRoutes())
}

export function apply(ctx: Context, _config: Config): void {
  const session = new PiLoginSession(new PiLoginCredentialStore())
  // Initial registration needs ≥1 route; replace() may then empty the set.
  const registration = ctx.llm.registerAdapter(
    piLoginRoutes(),
    createPiLoginAdapter(session, () => ctx.get('attachments')),
  )
  const refreshRoutes = (): Promise<void> => syncAuthenticatedRoutes(session, registration)
  void refreshRoutes()
  ctx.inject(['webServer'], webCtx => {
    registerPiLoginAuthRoutes(webCtx, session, { onAuthChanged: refreshRoutes })
  })
}
