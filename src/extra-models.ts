/**
 * Catalog models pi-ai has not shipped yet, but DSH OAuth routes already need.
 * Entries are merged on top of the installed pi-ai provider catalog.
 */

import type { Api, Model } from '@earendil-works/pi-ai'

/**
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * Use the Codex catalog's default 272K context, not the API's larger ceiling.
 * Ultra is an app orchestration mode, not a Pi reasoning effort.
 */
const OPENAI_CODEX_EXTRA_MODELS: readonly Model<Api>[] = [
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  },
]

/** Newer xAI Grok models missing from the installed pi-ai catalog (0.82.x). */
const XAI_EXTRA_MODELS: readonly Model<Api>[] = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    api: 'openai-responses',
    provider: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    compat: { supportsLongCacheRetention: false },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
  },
]

/** Latest Coding Plan models missing from the installed pi-ai catalog (0.82.x). */
export const GLM_5_3_MODEL_ID = 'glm-5.3'
export const GLM_5_3_DEFAULT_EFFORT = 'max'
export const GLM_5_3_FLASH_MODEL_ID = 'glm-5.3-flash'
export const GLM_5_3_FLASH_DEFAULT_EFFORT = 'max'

/**
 * Official GLM-5.3 family metadata. Standard is text-only; Flash also accepts
 * images. Keep separate IDs so choosing standard never routes to Flash.
 * https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
 * https://docs.bigmodel.cn/cn/coding-plan/latest-model
 */
const ZAI_CODING_CN_EXTRA_MODELS: readonly Model<Api>[] = [
  {
    id: GLM_5_3_FLASH_MODEL_ID,
    name: 'GLM-5.3-Flash',
    api: 'openai-completions',
    provider: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'zai',
      zaiToolStream: true,
    },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
  },
  {
    id: GLM_5_3_MODEL_ID,
    name: 'GLM-5.3',
    api: 'openai-completions',
    provider: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'zai',
      zaiToolStream: true,
    },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
  },
]

/** OpenRouter stealth model missing from the installed pi-ai catalog (0.82.x–0.84.x). */
export const OX_ALPHA_MODEL_ID = 'stealth/ox-alpha'

/**
 * OpenRouter's live default for ox-alpha (`reasoning.default_effort`).
 * Must be sent explicitly: pi-ai's OpenRouter dialect writes
 * `reasoning: { effort: thinkingLevelMap.off ?? "none" }` when the caller
 * omits an effort, and ox-alpha rejects `none` (`reasoning.mandatory: true`).
 */
export const OX_ALPHA_DEFAULT_EFFORT = 'max'

/**
 * OpenRouter stealth models missing from the installed pi-ai catalog (0.82.x).
 * Capacities follow the public OpenRouter listing: 1M context, text+image, free.
 * Effort levels follow live `/api/v1/models` (`supported_efforts`, `default_effort`).
 */
const OPENROUTER_EXTRA_MODELS: readonly Model<Api>[] = [
  {
    id: OX_ALPHA_MODEL_ID,
    name: 'OX Alpha',
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
    // Absent keys default to "supported" for off/minimal/low/medium/high and
    // "unsupported" for max — the opposite of this model's live metadata.
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
  },
]

/** Per-model default the selector and request path should apply when omitted. */
export function defaultReasoningEffortFor(
  modelId: string,
): typeof OX_ALPHA_DEFAULT_EFFORT | typeof GLM_5_3_DEFAULT_EFFORT | typeof GLM_5_3_FLASH_DEFAULT_EFFORT | 'medium' | undefined {
  if (modelId === 'gpt-6-astra') return 'medium'
  if (modelId === OX_ALPHA_MODEL_ID) return OX_ALPHA_DEFAULT_EFFORT
  if (modelId === GLM_5_3_MODEL_ID) return GLM_5_3_DEFAULT_EFFORT
  if (modelId === GLM_5_3_FLASH_MODEL_ID) return GLM_5_3_FLASH_DEFAULT_EFFORT
  return undefined
}

const EXTRA_MODELS_BY_PROVIDER: Readonly<Record<string, readonly Model<Api>[]>> = {
  'openai-codex': OPENAI_CODEX_EXTRA_MODELS,
  xai: XAI_EXTRA_MODELS,
  openrouter: OPENROUTER_EXTRA_MODELS,
  'zai-coding-cn': ZAI_CODING_CN_EXTRA_MODELS,
}

/**
 * Extra models this plugin publishes for one pi-ai provider id.
 * @param providerId - catalog provider id (e.g. `xai`), not the harness route.
 */
export function extraModelsFor(providerId: string): readonly Model<Api>[] {
  return EXTRA_MODELS_BY_PROVIDER[providerId] ?? []
}
