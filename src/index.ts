/**
 * DSH-owned multi-provider OAuth for DeepSeek Harness.
 * Independent store. Never touches Pi Agent or official CLI auth files.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { createPiLoginAdapter } from './adapter.ts'
import { registerPiLoginAuthRoutes } from './auth-routes.ts'
import { piLoginRoutes } from './catalog.ts'
import { maskDshWebAssembly, nativePlanForRoute } from './native-tools.ts'
import { OAUTH_REFRESH_POLL_MS } from './oauth-refresh.ts'
import type { Config } from './plugin-config.ts'
import { PiLoginSession } from './session.ts'
import { PiLoginCredentialStore } from './store.ts'

type NativeAssembly = {
  tools: { name: string }[]
  sections: { name: string; text: string }[]
}

type NativeAssembleContext = {
  agent?: { options?: { provider?: string } }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'system-prompt/assemble'(
      assembly: NativeAssembly,
      context: NativeAssembleContext,
      next: () => Promise<NativeAssembly>,
    ): Promise<NativeAssembly>
  }
}

export { createPiLoginAdapter } from './adapter.ts'
export type { PiLoginAdapterOptions } from './adapter.ts'
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
export {
  applyNativeToolsToPayload,
  DEFAULT_NATIVE_TOOL_POLICY,
  filterHostedServerToolTraces,
  filterXaiServerToolTraces,
  isHostedSearchReasoningReplay,
  isHostedServerToolCall,
  isXaiServerXSearchCall,
  nativePlan,
  nativePlanForRoute,
  prepareNativeToolRequest,
} from './native-tools.ts'
export {
  collectHostedImagesFromEvent,
  decodeHostedImage,
  injectHostedImages,
  sniffImageMediaType,
  stripAssistantImages,
} from './hosted-images.ts'
export type { NativeToolPlan, NativeToolPolicy } from './native-tools.ts'
export {
  grantNeedsRefresh,
  OAUTH_REFRESH_POLL_MS,
  OAUTH_REFRESH_SOON_MS,
} from './oauth-refresh.ts'
export { Config } from './plugin-config.ts'
export type { Config as PluginConfig } from './plugin-config.ts'
export {
  LEGACY_PI_LOGIN_AUTH_FILENAME,
  PI_LOGIN_AUTH_FILENAME,
  PI_LOGIN_BOOT_MARKER,
  PI_LOGIN_ROUTE_PREFIX,
  PI_LOGIN_STREAM_IDLE_TIMEOUT_MS,
} from './ids.ts'
export {
  hintFailure,
  hintForCode,
  QUOTA_HINT,
  RATE_LIMIT_HINT,
  TRANSIENT_HINT,
  TRANSIENT_MODEL_CODES,
  withModelErrorHint,
} from './model-error-hint.ts'
export { catalogProvider, harnessModels, harnessProvider, preferredModel } from './provider.ts'
export { isSafeAuthUrl, safeMessage } from './redact.ts'
export { PiLoginSession } from './session.ts'
export { PiLoginCredentialStore, piLoginAuthPath } from './store.ts'

export const name = 'llm-oauth-login'
export const inject = ['llm']

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

export function apply(ctx: Context, config: Config): void {
  console.log('[my-plugins/dsh-oauth-login] loaded')
  const native = {
    enabled: config.nativeTools !== false,
    image: config.nativeImage !== false,
  }
  const session = new PiLoginSession(new PiLoginCredentialStore(), native)
  // Initial registration needs ≥1 route; replace() may then empty the set.
  const registration = ctx.llm.registerAdapter(
    piLoginRoutes(),
    createPiLoginAdapter(session, () => ctx.get('attachments'), {
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      retryPolicy: config.retryPolicy,
    }),
  )
  const refreshRoutes = (): Promise<void> => syncAuthenticatedRoutes(session, registration)
  void refreshRoutes()
  ctx.effect(() => {
    const timer = setInterval(() => {
      void session.refreshStoredGrants()
    }, OAUTH_REFRESH_POLL_MS)
    void session.refreshStoredGrants()
    return () => clearInterval(timer)
  }, 'dsh-oauth-login: refresh oauth grants')
  ctx.inject(['webServer'], webCtx => {
    registerPiLoginAuthRoutes(webCtx, session, { onAuthChanged: refreshRoutes })
  })
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const plan = nativePlanForRoute(context.agent?.options?.provider, session.native)
      return plan === undefined ? assembled : maskDshWebAssembly(assembled, plan)
    })
  })
}
