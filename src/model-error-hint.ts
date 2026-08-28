/** Provider-specific failure compatibility and user-facing model error copy. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/**
 * Default Harness `retryPolicy` codes. Keep aligned with
 * `resolveRetryPolicy(undefined)` in `@deepseek-ai/dsh-llm`.
 */
export const TRANSIENT_MODEL_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

export const QUOTA_HINT = 'This is account quota or credits, not a temporary busy signal. Automatic retry will not refill it. Check the plan, usage window, or balance.'
export const RATE_LIMIT_HINT = 'This is a request-rate or peak-busy limit. A 429 is often this, not an empty balance. After automatic retries end, wait and send another message. If Continue fails or the composer stays stuck, start a new chat.'
export const TRANSIENT_HINT = 'After this turn ends, send another message to try again. If Continue fails or the composer stays stuck, start a new chat.'

const SENTINELS = [
  'Automatic retry will not refill it',
  'request-rate or peak-busy limit',
  'After this turn ends, send another message',
] as const

/** Stable Chat copy for one official `LlmError` code. Does not invent 5h vs weekly vs billing. */
export function hintForCode(code: string): string | undefined {
  if (code === 'QUOTA') return QUOTA_HINT
  if (code === 'RATE_LIMIT') return RATE_LIMIT_HINT
  if ((TRANSIENT_MODEL_CODES as readonly string[]).includes(code)) return TRANSIENT_HINT
  return undefined
}

function alreadyHinted(message: string): boolean {
  return SENTINELS.some(marker => message.includes(marker))
}

/** Read only the top-level Zhipu error code, never incidental request or message text. */
function isZhipuPlanQuota(message: string): boolean {
  const match = /^\s*429\s*:\s*(\{[\s\S]*\})\s*$/.exec(message)
  if (match === null) return false
  let payload: unknown
  try {
    payload = JSON.parse(match[1]!)
  } catch (_malformedProviderJson) {
    return false
  }
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    && 'code' in payload && (payload.code === '1310' || payload.code === 1310)
}

/** Repair only observed route-specific classification gaps; keep all other official codes. */
function providerFailure(failure: LlmFailure, provider: string | undefined): LlmFailure {
  // The upstream word-boundary matcher recognizes "socket" but misses
  // "WebSocket". Keep policy/protocol/size failures out of this narrow repair.
  if (provider === 'pi-openai-codex' && failure.code === 'PI_AI_ERROR'
    && (/^WebSocket error$/i.test(failure.message.trim())
      || /^WebSocket closed (?:1000|1001|1005|1006|1011|1012|1013)(?:\s|$)/i.test(failure.message.trim()))) {
    return { ...failure, code: 'TRANSPORT' }
  }
  if (provider === 'pi-openai-codex' && failure.code === 'PI_AI_ERROR'
    && /\b(?:servers?|engine)\s+(?:are|is)\s+(?:currently\s+)?overloaded\b/i.test(failure.message)) {
    return { ...failure, code: 'SERVER' }
  }
  if (provider === 'pi-zai-coding-cn' && failure.code === 'RATE_LIMIT'
    && isZhipuPlanQuota(failure.message)) {
    return { ...failure, code: 'QUOTA' }
  }
  return failure
}

/** Normalize known provider gaps before the official retry executor receives this failure. */
export function hintFailure(failure: LlmFailure, provider?: string): LlmFailure {
  const normalized = providerFailure(failure, provider)
  const hint = hintForCode(normalized.code)
  if (hint === undefined || alreadyHinted(normalized.message)) return normalized
  return {
    ...normalized,
    message: `${normalized.message} ${hint}`,
  }
}

/** Apply the same provider correction and hint to thrown failures, preserving diagnostics. */
export function withModelErrorHint(error: unknown, provider?: string): unknown {
  if (!(error instanceof LlmError)) return error
  const hinted = hintFailure(error.failure, provider)
  if (hinted === error.failure) return error
  return new LlmError(hinted.message, hinted.code, {
    cause: error,
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
  })
}
