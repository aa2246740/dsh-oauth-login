import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { OpenRouterModel } from './openrouter-types.ts'

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^~?[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length < 256))]
    : []
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Conservative, all-cost classification. Missing/invalid prices, unknown
 * structures and conditional overrides never become a free badge. In
 * particular, a tiny positive decimal must not underflow into a free price.
 */
export function classifyOpenRouterPricing(value: unknown): {
  pricing: Record<string, string>
  priceStatus: OpenRouterModel['priceStatus']
} {
  const source = objectValue(value)
  const pricing: Record<string, string> = {}
  let unknown = source === undefined || source.prompt === undefined || source.completion === undefined
  let paid = false
  for (const [key, raw] of Object.entries(source ?? {})) {
    if (key === 'overrides') {
      // A scheduled/long-context exception is not an unconditional free offer.
      if (!Array.isArray(raw) || raw.length > 0) unknown = true
      continue
    }
    if (typeof raw !== 'string' || raw.length > 128 || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) {
      unknown = true
      continue
    }
    const numeric = Number(raw)
    if (!Number.isFinite(numeric) || numeric < 0) {
      unknown = true
      continue
    }
    pricing[key] = raw
    if (!/^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(raw)) paid = true
  }
  return { pricing, priceStatus: paid ? 'paid' : unknown ? 'unknown' : 'free' }
}

export function normalizeOpenRouterModels(raw: unknown): OpenRouterModel[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10_000) {
    throw new Error('OpenRouter returned an empty or invalid model catalog')
  }
  const seen = new Set<string>()
  const out: OpenRouterModel[] = []
  for (const entry of raw) {
    const row = objectValue(entry)
    if (row === undefined || !validModelId(row.id)) throw new Error('Invalid OpenRouter model ID')
    // Batch-only endpoints and non-text generators cannot use DSH's chat stream.
    if (row.id.endsWith(':batch')) continue
    const architecture = objectValue(row.architecture)
    const inputModalities = strings(architecture?.input_modalities)
    const outputModalities = strings(architecture?.output_modalities)
    if (!inputModalities.includes('text') || !outputModalities.includes('text')) continue
    if (seen.has(row.id)) throw new Error('Duplicate OpenRouter model ID')
    const top = objectValue(row.top_provider)
    const contextWindow = positiveInteger(row.context_length) ?? positiveInteger(top?.context_length)
    if (contextWindow === undefined) throw new Error('Invalid OpenRouter context limit')
    const supportedParameters = strings(row.supported_parameters)
    const reason = objectValue(row.reasoning)
    const reasoning = supportedParameters.some(key => key === 'reasoning' || key === 'include_reasoning')
    const supportedEfforts = strings(reason?.supported_efforts)
    const defaultEffort = typeof reason?.default_effort === 'string' ? reason.default_effort : undefined
    const maxTokens = Math.min(contextWindow, positiveInteger(top?.max_completion_tokens) ?? Math.min(contextWindow, 8192))
    out.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.slice(0, 256) : row.id,
      contextWindow,
      maxTokens,
      inputModalities,
      outputModalities,
      supportedParameters,
      tools: supportedParameters.includes('tools'),
      reasoning,
      reasoningMandatory: reasoning && reason?.mandatory === true,
      ...supportedEfforts.length === 0 ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      ...classifyOpenRouterPricing(row.pricing),
      ...typeof row.expiration_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.expiration_date)
        ? { deprecatesAt: row.expiration_date } : {},
    })
    seen.add(row.id)
  }
  if (out.length === 0) throw new Error('OpenRouter returned no usable text models')
  return out
}

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function openRouterThinkingMap(info: OpenRouterModel, base?: Model<Api>): ThinkingLevelMap | undefined {
  if (!info.reasoning) return undefined
  if (info.supportedEfforts === undefined) {
    return {
      ...base?.thinkingLevelMap,
      ...info.reasoningMandatory ? { off: null } : {},
    }
  }
  const map: ThinkingLevelMap = {}
  for (const level of LEVELS) {
    const wire = level === 'off' ? 'none' : level
    map[level] = info.supportedEfforts.includes(wire) && !(level === 'off' && info.reasoningMandatory)
      ? wire : null
  }
  return map
}

export function openRouterDefaultEffort(info: OpenRouterModel | undefined): string | undefined {
  if (info?.reasoning !== true) return undefined
  if (info.defaultEffort !== undefined && info.defaultEffort !== 'none') return info.defaultEffort
  if (!info.reasoningMandatory) return undefined
  return info.supportedEfforts?.find(level => level === 'high')
    ?? info.supportedEfforts?.find(level => level !== 'none')
    ?? 'high'
}

export function openRouterPiModel(info: OpenRouterModel, base?: Model<Api>): Model<Api> {
  const rate = (key: string): number => {
    const value = Number(info.pricing[key] ?? 0) * 1_000_000
    return Number.isFinite(value) ? value : 0
  }
  const thinkingLevelMap = openRouterThinkingMap(info, base)
  return {
    ...base,
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    input: info.inputModalities.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: info.reasoning,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    cost: { input: rate('prompt'), output: rate('completion'), cacheRead: rate('input_cache_read'), cacheWrite: rate('input_cache_write') },
    compat: { ...base?.compat, supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
  }
}
