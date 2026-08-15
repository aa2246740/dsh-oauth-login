/** One PiAiAdapter covering every Pi-login harness route. */

import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { PI_LOGIN_PROVIDERS, piLoginProviderByRoute } from './catalog.ts'
import { PI_LOGIN_STREAM_IDLE_TIMEOUT_MS } from './ids.ts'
import type { PiLoginSession } from './session.ts'

export function createPiLoginAdapter(
  session: PiLoginSession,
  resolveAttachments: () => AttachmentStore | undefined,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => {
      const profiles = new Map<string, ResolvedPiAiProviderProfile>()
      for (const spec of PI_LOGIN_PROVIDERS) {
        profiles.set(spec.route, {
          provider: spec.route,
          displayName: spec.displayName,
          streamIdleTimeoutMs: PI_LOGIN_STREAM_IDLE_TIMEOUT_MS,
          retryPolicy: resolveRetryPolicy(undefined, 'dsh-pi-login retryPolicy'),
          configuredMaxTokens: new Map(),
          piProvider: session.provider(spec.id),
        })
      }
      return profiles
    },
    resolveApiKey: async (route) => {
      const spec = piLoginProviderByRoute(route)
      if (spec === undefined) {
        throw new LlmError(`dsh-pi-login: unknown route "${route}"`, 'MISSING_CREDENTIAL')
      }
      const auth = await session.models.getAuth(spec.id)
      const apiKey = auth?.auth.apiKey
      if (apiKey === undefined || apiKey.length === 0) {
        throw new LlmError(
          `${spec.displayName} is not signed in. Open Settings → Pi Login and sign in.`,
          'MISSING_CREDENTIAL',
        )
      }
      return apiKey
    },
    resolveAttachments,
  })
}
