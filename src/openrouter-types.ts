/** Browser-safe contract. No credentials, provider URLs or server imports. */
export const OPENROUTER_CATALOG_PATH = '/plugins/dsh-oauth-login/openrouter/models'
export const OPENROUTER_REFRESH_PATH = OPENROUTER_CATALOG_PATH + '/refresh'
export const OPENROUTER_ROUTE = 'pi-openrouter'
export const OPENROUTER_REFRESH_MS = 15 * 60_000
export const OPENROUTER_COOLDOWN_MS = 60_000

export interface OpenRouterModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  inputModalities: string[]
  outputModalities: string[]
  supportedParameters: string[]
  tools: boolean
  reasoning: boolean
  reasoningMandatory: boolean
  supportedEfforts?: string[]
  defaultEffort?: string
  /** USD per token/unit as supplied by the official catalog, not pi-ai costs. */
  pricing: Record<string, string>
  priceStatus: 'free' | 'paid' | 'unknown'
  /** Endpoint deprecation, NEVER interpreted as a promotion deadline. */
  deprecatesAt?: string
}

export interface OpenRouterCatalogSnapshot {
  version: 1
  connected: boolean
  refreshing: boolean
  source: 'builtin' | 'cache' | 'live'
  lastUpdatedAt: number | null
  lastAttemptAt: number | null
  nextRefreshAt: number | null
  retryAt: number | null
  stale: boolean
  error: 'fetch' | 'cache' | 'save' | null
  models: Array<OpenRouterModel & { freeOnly: boolean }>
}
