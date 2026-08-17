/**
 * Catalog models pi-ai has not shipped yet, but DSH OAuth routes already need.
 * Entries are merged on top of the installed pi-ai provider catalog.
 */

import type { Api, Model } from '@earendil-works/pi-ai'

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

const EXTRA_MODELS_BY_PROVIDER: Readonly<Record<string, readonly Model<Api>[]>> = {
  xai: XAI_EXTRA_MODELS,
}

/**
 * Extra models this plugin publishes for one pi-ai provider id.
 * @param providerId - catalog provider id (e.g. `xai`), not the harness route.
 */
export function extraModelsFor(providerId: string): readonly Model<Api>[] {
  return EXTRA_MODELS_BY_PROVIDER[providerId] ?? []
}
