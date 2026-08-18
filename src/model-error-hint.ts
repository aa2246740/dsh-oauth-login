/** User-facing copy for classified model failures this plugin owns. */

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

export function hintFailure(failure: LlmFailure): LlmFailure {
  const hint = hintForCode(failure.code)
  if (hint === undefined || alreadyHinted(failure.message)) return failure
  return {
    ...failure,
    message: `${failure.message} ${hint}`,
  }
}

/** Append a code-specific hint without changing the routable `code`. */
export function withModelErrorHint(error: unknown): unknown {
  if (!(error instanceof LlmError)) return error
  const hinted = hintFailure(error.failure)
  if (hinted === error.failure) return error
  return new LlmError(hinted.message, error.code, {
    cause: error,
    ...error.failure.status === undefined ? {} : { status: error.failure.status },
    ...error.failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
    ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
  })
}
