/**
 * OAuth routes that already have provider-hosted search / image tools.
 * DSH's web_search function tool would hide those and bill a second key.
 */

import type { Context as PiContext, StreamOptions } from '@earendil-works/pi-ai'
import type { ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import { piLoginProviderByRoute } from './catalog.ts'

/** DSH model-facing tools that steal traffic from a subscribed provider. */
export const DSH_WEB_TOOL_NAMES = ['web_search', 'web_fetch'] as const

/** Matching tool-web prompt sections. */
export const DSH_WEB_SECTION_NAMES = ['tool:web_search', 'tool:web_fetch'] as const

const DSH_WEB_TOOL_NAME_SET = new Set<string>(DSH_WEB_TOOL_NAMES)
const DSH_WEB_SECTION_NAME_SET = new Set<string>(DSH_WEB_SECTION_NAMES)

/** Precise xAI server-side X Search operations published by the provider. */
export const XAI_SERVER_X_SEARCH_NAMES = [
  'x_user_search',
  'x_keyword_search',
  'x_semantic_search',
  'x_thread_fetch',
] as const

const XAI_SERVER_X_SEARCH_NAME_SET = new Set<string>(XAI_SERVER_X_SEARCH_NAMES)

/**
 * Hosted / server-executed names that can leak as client function calls
 * after this plugin removes DSH's implementations from the route.
 */
export const HOSTED_CLIENT_LEAK_NAMES = [
  ...XAI_SERVER_X_SEARCH_NAMES,
  'web_search',
  'web_fetch',
  'image_generation',
  'imagine_text_to_image',
  'imagine_image_to_image',
  'imagine_image_edit',
] as const

const HOSTED_CLIENT_LEAK_NAME_SET = new Set<string>(HOSTED_CLIENT_LEAK_NAMES)

export interface NativeToolPolicy {
  /** Attach hosted tools and hide DSH web_search / web_fetch. Default true. */
  enabled: boolean
  /** Also attach hosted image generation where the provider documents it. Default true. */
  image: boolean
}

export const DEFAULT_NATIVE_TOOL_POLICY: NativeToolPolicy = {
  enabled: true,
  image: true,
}

export interface NativeToolPlan {
  readonly providerId: string
  readonly hosted: readonly Record<string, unknown>[]
  readonly guidance: string
}

const SEARCH_GUIDANCE =
  'This turn already includes this account\'s native hosted search. Do not call web_search or web_fetch — those DSH tools are not available on this route.'

const SEARCH_AND_IMAGE_GUIDANCE =
  'This turn already includes this account\'s native hosted search and image generation. Do not call web_search or web_fetch — those DSH tools are not available on this route.'

function responsesSearch(): Record<string, unknown> {
  return { type: 'web_search' }
}

function responsesXSearch(): Record<string, unknown> {
  return { type: 'x_search' }
}

function responsesImage(): Record<string, unknown> {
  return { type: 'image_generation' }
}

function anthropicSearch(): Record<string, unknown> {
  return { type: 'web_search_20250305', name: 'web_search' }
}

export function nativePlan(
  providerId: string,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): NativeToolPlan | undefined {
  if (!policy.enabled) return undefined
  switch (providerId) {
    case 'xai':
      return {
        providerId,
        hosted: [
          responsesSearch(),
          responsesXSearch(),
          ...policy.image ? [responsesImage()] : [],
        ],
        guidance: policy.image ? SEARCH_AND_IMAGE_GUIDANCE : SEARCH_GUIDANCE,
      }
    case 'openai-codex':
      return {
        providerId,
        hosted: [
          responsesSearch(),
          ...policy.image ? [responsesImage()] : [],
        ],
        guidance: policy.image ? SEARCH_AND_IMAGE_GUIDANCE : SEARCH_GUIDANCE,
      }
    case 'anthropic':
      return {
        providerId,
        hosted: [anthropicSearch()],
        guidance: SEARCH_GUIDANCE,
      }
    default:
      return undefined
  }
}

export function nativePlanForRoute(
  route: string | undefined,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): NativeToolPlan | undefined {
  if (route === undefined) return undefined
  const spec = piLoginProviderByRoute(route)
  return spec === undefined ? undefined : nativePlan(spec.id, policy)
}

export function isDshWebToolName(name: string): boolean {
  return DSH_WEB_TOOL_NAME_SET.has(name)
}

export function isDshWebSectionName(name: string): boolean {
  return DSH_WEB_SECTION_NAME_SET.has(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * xAI's Responses stream currently exposes server-executed X Search details
 * as custom tool calls. The outer `xs_call-*` id distinguishes those traces
 * from a same-named client function, which Harness must still execute.
 */
export function isXaiServerXSearchCall(block: unknown): boolean {
  if (!isRecord(block) || block.type !== 'tool-call') return false
  if (typeof block.name !== 'string' || !XAI_SERVER_X_SEARCH_NAME_SET.has(block.name)) return false
  if (typeof block.id !== 'string') return false
  const outerId = block.id.split('|', 1)[0] ?? ''
  return /^xs_call[-_]/.test(outerId)
}

/**
 * Server-executed hosted search / image traces that Harness must not try to run.
 * X Search leaks use `xs_call-*`. DSH `web_search` / `web_fetch` were stripped
 * from this route, so a leftover same-named call is also a leak.
 */
export function isHostedServerToolCall(block: unknown): boolean {
  if (!isRecord(block) || block.type !== 'tool-call') return false
  if (typeof block.name !== 'string' || !HOSTED_CLIENT_LEAK_NAME_SET.has(block.name)) return false
  if (isXaiServerXSearchCall(block)) return true
  if (block.name === 'web_search' || block.name === 'web_fetch') return true
  return block.name === 'image_generation' || block.name.startsWith('imagine_')
}

/**
 * xAI hosted search hops arrive as empty `reasoning` blocks whose signature
 * id is `tco_<response>_call-…`. The UI renders each as a blank Think card.
 */
export function isHostedSearchReasoningReplay(block: unknown): boolean {
  if (!isRecord(block) || block.type !== 'reasoning') return false
  const signature = block.thinkingSignature
  if (typeof signature !== 'string' || signature.length === 0) return false
  try {
    const parsed = JSON.parse(signature) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.startsWith('tco_')
  } catch {
    return signature.includes('"id":"tco_') || signature.startsWith('tco_')
  }
}

function filterPiReplayState(
  replayState: ReplayEnvelope | undefined,
  dropped: ReadonlySet<number>,
  forceStop: boolean,
): ReplayEnvelope | undefined {
  if (replayState === undefined
    || !isRecord(replayState.response)
    || replayState.response.kind !== 'pi-ai'
    || !Array.isArray(replayState.blocks)) {
    return replayState
  }
  let seenText = false
  return {
    ...replayState,
    blocks: replayState.blocks.filter((block, index) => {
      if (dropped.has(index) || isHostedSearchReasoningReplay(block)) return false
      if (isRecord(block) && block.type === 'text') {
        seenText = true
        return true
      }
      // Hosted search keeps emitting English planning after the visible
      // answer has started; DSH would pin that Think under the reply.
      if (seenText && isRecord(block) && block.type === 'reasoning') return false
      return true
    }),
    response: {
      ...replayState.response,
      ...forceStop ? { stopReason: 'stop' } : {},
    },
  }
}

function isEmptyReasoningText(text: string): boolean {
  return text.trim().length === 0
}

/**
 * Remove hosted server-side search / image traces after pi-ai 0.82.1 has
 * mistaken them for client function calls. Other blocks retain stream order,
 * actual client tools survive, and pi-ai replay metadata stays index-aligned.
 */
export async function* filterHostedServerToolTraces(
  source: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const dropped = new Set<number>()
  const pending = new Set<number>()
  const reasoning = new Map<number, { chunks: StreamChunk[]; text: string; afterText: boolean }>()
  let buffered: StreamChunk[] = []
  let keptToolCalls = 0
  let textStarted = false

  const flush = function* (): Generator<StreamChunk> {
    for (const item of buffered) {
      if ('index' in item && dropped.has(item.index)) continue
      yield item
    }
    buffered = []
  }

  const closeReasoning = function* (index: number, end?: StreamChunk): Generator<StreamChunk> {
    const held = reasoning.get(index)
    if (held === undefined) {
      if (end !== undefined) yield end
      return
    }
    reasoning.delete(index)
    const ended = end?.type === 'block-end' && end.block.type === 'reasoning' ? end.block.text : ''
    const text = ended.length > 0 ? ended : held.text
    if (held.afterText || isEmptyReasoningText(text)) return
    yield* held.chunks
    if (end !== undefined) yield end
  }

  for await (const chunk of source) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text' || chunk.type === 'text-delta') {
      textStarted = true
    }

    if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
      reasoning.set(chunk.index, { chunks: [chunk], text: '', afterText: textStarted })
      continue
    }

    if (chunk.type === 'reasoning-delta' && reasoning.has(chunk.index)) {
      const held = reasoning.get(chunk.index)
      if (held !== undefined) {
        held.chunks.push(chunk)
        held.text += chunk.text
      }
      continue
    }

    if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
      yield* closeReasoning(chunk.index, chunk)
      continue
    }

    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      pending.add(chunk.index)
      buffered.push(chunk)
      continue
    }

    if (pending.size > 0) {
      buffered.push(chunk)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && pending.has(chunk.index)) {
        if (isHostedServerToolCall(chunk.block)) dropped.add(chunk.index)
        else keptToolCalls += 1
        pending.delete(chunk.index)
        if (pending.size === 0) yield* flush()
      }
      continue
    }

    if (chunk.type === 'finish') {
      for (const index of [...reasoning.keys()]) yield* closeReasoning(index)
      const forceStop = chunk.reason.kind === 'tool-calls' && dropped.size > 0 && keptToolCalls === 0
      yield {
        ...chunk,
        ...(forceStop ? { reason: { kind: 'stop' as const } } : {}),
        replayState: filterPiReplayState(chunk.replayState, dropped, forceStop),
      }
      continue
    }

    yield chunk
  }

  // Preserve malformed/incomplete upstream evidence instead of silently
  // swallowing it; the base adapter will normally finish every block.
  for (const index of [...reasoning.keys()]) yield* closeReasoning(index)
  if (buffered.length > 0) yield* flush()
}

/** @deprecated Use {@link filterHostedServerToolTraces}. */
export const filterXaiServerToolTraces = filterHostedServerToolTraces

/** A function-calling tool DSH registered as web_search / web_fetch. */
export function isDshWebFunctionTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false
  const name = typeof tool.name === 'string' ? tool.name : undefined
  if (name === undefined || !isDshWebToolName(name)) return false
  const type = tool.type
  return type === undefined || type === 'function'
}

export function hostedToolKey(tool: Record<string, unknown>): string {
  const type = typeof tool.type === 'string' ? tool.type : 'function'
  const name = typeof tool.name === 'string' ? tool.name : ''
  return `${type}:${name}`
}

export function applyNativeToolsToPayload(
  payload: unknown,
  providerId: string,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): unknown {
  const plan = nativePlan(providerId, policy)
  if (plan === undefined || !isRecord(payload) || !Array.isArray(payload.tools)) return payload
  const current = payload.tools
  const kept = current.filter(tool => !isDshWebFunctionTool(tool))
  const seen = new Set(
    kept.filter(isRecord).map(tool => hostedToolKey(tool)),
  )
  const hosted = plan.hosted.filter(tool => {
    const key = hostedToolKey(tool)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...payload, tools: [...hosted, ...kept] }
}

export function wrapOnPayload(
  existing: StreamOptions['onPayload'],
  providerId: string,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): StreamOptions['onPayload'] {
  if (nativePlan(providerId, policy) === undefined) return existing
  return async (payload, model) => {
    const injected = applyNativeToolsToPayload(payload, providerId, policy)
    if (existing === undefined) return injected
    return await existing(injected, model)
  }
}

export function filterPiContext(
  context: PiContext,
  providerId: string,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): PiContext {
  if (nativePlan(providerId, policy) === undefined || context.tools === undefined) return context
  return {
    ...context,
    tools: context.tools.filter(tool => !isDshWebToolName(tool.name)),
  }
}

/**
 * Prepare one provider request as a single unit.
 *
 * Native tools are a property of this request, not of the provider account.
 * A context without tools is a text-only call (reviewers, summaries, titles,
 * and similar utility traffic), so its payload hook must stay untouched even
 * when the provider serializer later emits `tools: []`.
 */
export function prepareNativeToolRequest<TOptions extends StreamOptions>(
  context: PiContext,
  options: TOptions,
  providerId: string,
  policy: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
): { context: PiContext; options: TOptions & StreamOptions } {
  if (context.tools === undefined || nativePlan(providerId, policy) === undefined) {
    return { context, options }
  }
  const onPayload = wrapOnPayload(options?.onPayload, providerId, policy)
  return {
    context: filterPiContext(context, providerId, policy),
    options: onPayload === options.onPayload
      ? options
      : Object.assign({}, options, { onPayload }),
  }
}

export function maskDshWebAssembly<
  T extends {
    tools: readonly { name: string }[]
    sections: readonly { name: string; text: string }[]
  },
>(assembly: T, plan: NativeToolPlan): T {
  return {
    ...assembly,
    tools: assembly.tools.filter(tool => !isDshWebToolName(tool.name)),
    sections: [
      ...assembly.sections.filter(section => !isDshWebSectionName(section.name)),
      { name: 'oauth:native-tools', text: plan.guidance },
    ],
  }
}
