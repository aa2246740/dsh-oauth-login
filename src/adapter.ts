/** One PiAiAdapter covering every Pi-login harness route. */

import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { PI_LOGIN_PROVIDERS, piLoginProviderByRoute } from './catalog.ts'
import { PI_LOGIN_STREAM_IDLE_TIMEOUT_MS } from './ids.ts'
import { hintFailure, withModelErrorHint } from './model-error-hint.ts'
import type { PiLoginSession } from './session.ts'

export interface PiLoginAdapterOptions {
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

/**
 * Official Pi adapter plus Chat copy. `dsh-llm-retry` still owns the attempt
 * budget and routes on `code`. Provider 429/quota usually arrive as finish
 * chunks, not thrown errors, so both paths get the same hint.
 */
class PiLoginAdapter extends PiAiAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of super.stream(options)) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          yield {
            ...chunk,
            reason: {
              ...chunk.reason,
              failure: hintFailure(chunk.reason.failure),
            },
          }
          continue
        }
        yield chunk
      }
    } catch (error: unknown) {
      throw withModelErrorHint(error)
    }
  }
}

export function createPiLoginAdapter(
  session: PiLoginSession,
  resolveAttachments: () => AttachmentStore | undefined,
  options: PiLoginAdapterOptions = {},
): PiAiAdapter {
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? PI_LOGIN_STREAM_IDLE_TIMEOUT_MS
  const retryPolicy = resolveRetryPolicy(options.retryPolicy, 'dsh-oauth-login retryPolicy')
  return new PiLoginAdapter({
    profiles: () => {
      const profiles = new Map<string, ResolvedPiAiProviderProfile>()
      for (const spec of PI_LOGIN_PROVIDERS) {
        profiles.set(spec.route, {
          provider: spec.route,
          displayName: spec.displayName,
          streamIdleTimeoutMs,
          retryPolicy,
          configuredMaxTokens: new Map(),
          piProvider: session.provider(spec.id),
        })
      }
      return profiles
    },
    resolveApiKey: async (route) => {
      await session.ensureTransport()
      const spec = piLoginProviderByRoute(route)
      if (spec === undefined) {
        throw new LlmError(`dsh-oauth-login: unknown route "${route}"`, 'MISSING_CREDENTIAL')
      }
      const auth = await session.models.getAuth(spec.id)
      const apiKey = auth?.auth.apiKey
      if (apiKey === undefined || apiKey.length === 0) {
        throw new LlmError(
          `${spec.displayName} is not signed in. Open Settings → OAuth Login and sign in.`,
          'MISSING_CREDENTIAL',
        )
      }
      return apiKey
    },
    resolveAttachments,
  })
}
