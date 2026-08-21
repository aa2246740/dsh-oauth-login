/** Provider-owned knobs published on the `llm-oauth-login` row. */

import z from '@deepseek-ai/schemastery'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { PI_LOGIN_STREAM_IDLE_TIMEOUT_MS } from './ids.ts'

/**
 * `retryPolicy` is executed by shipped `dsh-llm-retry`, not by this plugin.
 * Omission keeps the RC8 official normal default (5 retries for TIMEOUT /
 * TRANSPORT / SERVER / RATE_LIMIT / EMPTY_RESPONSE).
 */
export interface Config {
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  /**
   * Hide DSH web_search / web_fetch on OAuth routes that already have hosted
   * search, and attach those hosted tools to the provider request.
   */
  nativeTools?: boolean
  /** Also attach hosted image generation on Grok and Codex. */
  nativeImage?: boolean
}

export const Config: z<Config> = z.object({
  streamIdleTimeoutMs: z.number().min(1).default(PI_LOGIN_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  nativeTools: z.boolean().default(true),
  nativeImage: z.boolean().default(true),
})
