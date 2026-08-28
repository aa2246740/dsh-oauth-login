/** One PiAiAdapter covering every Pi-login harness route. */

import { LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { defaultProviderAuthContext } from '@earendil-works/pi-ai'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  PiAiAdapterOptions as BasePiAiAdapterOptions,
  ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { PI_LOGIN_PROVIDERS, piLoginProviderByRoute } from './catalog.ts'
import { defaultReasoningEffortFor } from './extra-models.ts'
import { iterateInCapture } from './hosted-capture.ts'
import type { HostedCapture } from './hosted-capture.ts'
import { injectHostedImages, stripAssistantImages } from './hosted-images.ts'
import {
  PI_LOGIN_MAX_REQUEST_IMAGE_BYTES,
  PI_LOGIN_STREAM_IDLE_TIMEOUT_MS,
} from './ids.ts'
import { hintFailure, withModelErrorHint } from './model-error-hint.ts'
import type { PiLoginSession } from './session.ts'
import { openRouterDefaultEffort } from './openrouter-models.ts'
import { OPENROUTER_ROUTE } from './openrouter-types.ts'
import { filterHostedServerToolTraces, nativePlanForRoute } from './native-tools.ts'
import type { NativeToolPolicy } from './native-tools.ts'

export interface PiLoginAdapterOptions {
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

/** Keep provider failures routable for both direct and snapshot-prepared requests. */
async function* withFailureHints(source: AsyncIterable<StreamChunk>, provider: string): AsyncIterable<StreamChunk> {
  try {
    for await (const chunk of source) {
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        yield { ...chunk, reason: { ...chunk.reason, failure: hintFailure(chunk.reason.failure, provider) } }
      } else {
        yield chunk
      }
    }
  } catch (error: unknown) {
    throw withModelErrorHint(error, provider)
  }
}

/**
 * Official Pi adapter plus bounded provider compatibility and Chat copy.
 * `dsh-llm-retry` owns the attempt budget and routes on `code`. Finish chunks
 * and thrown errors receive the same route-specific correction and hint.
 */
class PiLoginAdapter extends PiAiAdapter {
  constructor(
    config: BasePiAiAdapterOptions,
    private readonly native: NativeToolPolicy,
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    private readonly session: PiLoginSession,
  ) {
    super(config)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return super.resolveModel(provider, model, signal).then((info) => {
      const defaultEffort = this.defaultEffort(provider, model)
      if (defaultEffort === undefined || info.reasoning === undefined) return info
      return {
        ...info,
        reasoning: {
          ...info.reasoning,
          defaultEffort: ReasoningEffortId(defaultEffort),
        },
      }
    })
  }

  private defaultEffort(provider: string, model: string): string | undefined {
    return (provider === OPENROUTER_ROUTE ? openRouterDefaultEffort(this.session.openRouter.model(model)) : undefined)
      ?? defaultReasoningEffortFor(model)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.session.proxy.run(() => super.prepareCall(provider, model, signal))
    return {
      ...prepared,
      stream: options => withFailureHints(this.session.proxy.iterate(
        prepared.stream(options),
        provider === 'pi-openai-codex' && options.sessionId !== undefined ? String(options.sessionId) : undefined,
      ), provider),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const capture: HostedCapture = { images: [] }
    const defaultEffort = this.defaultEffort(options.provider, options.model)
    const sanitized: GenerateOptions = {
      ...options,
      messages: stripAssistantImages(options.messages),
      ...options.reasoningEffort === undefined && defaultEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(defaultEffort) }
        : {},
    }
    try {
      const raw = iterateInCapture(capture, this.session.proxy.iterate(
        super.stream(sanitized),
        sanitized.provider === 'pi-openai-codex' && sanitized.sessionId !== undefined ? String(sanitized.sessionId) : undefined,
      ))
      const plan = this.native.enabled ? nativePlanForRoute(sanitized.provider, this.native) : undefined
      const filtered = plan === undefined ? raw : filterHostedServerToolTraces(raw)
      const attachments = this.native.image ? this.resolveAttachments() : undefined
      const source = attachments === undefined
        ? filtered
        : injectHostedImages(filtered, capture, input => attachments.saveImage(input))
      yield* withFailureHints(source, sanitized.provider)
    } catch (error: unknown) {
      throw withModelErrorHint(error, sanitized.provider)
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
  const requestImageLimits = {
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
  }
  const auth = {
    auth: {
      credentials: session.store,
      authContext: defaultProviderAuthContext(),
    },
  }
  return new PiLoginAdapter({
    profiles: () => {
      const profiles = new Map<string, ResolvedPiAiProviderProfile>()
      for (const spec of PI_LOGIN_PROVIDERS) {
        profiles.set(spec.route, {
          provider: spec.route,
          displayName: spec.displayName,
          streamIdleTimeoutMs,
          maxRequestImageBytes: PI_LOGIN_MAX_REQUEST_IMAGE_BYTES,
          ...requestImageLimits,
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
          `${spec.displayName} is not connected. Open Settings → Subscription Login and connect it.`,
          'MISSING_CREDENTIAL',
        )
      }
      return apiKey
    },
    resolveAttachments,
    ...auth,
  }, session.native, resolveAttachments, session)
}
