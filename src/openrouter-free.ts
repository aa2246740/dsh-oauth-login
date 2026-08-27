/** The zero-cost policy is applied LAST, at the actual provider payload seam. */
import type { Api, Model, StreamOptions } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { OpenRouterCatalog } from './openrouter-catalog.ts'
import { objectValue, openRouterDefaultEffort } from './openrouter-models.ts'

const FREE_ONLY_MESSAGE = 'OpenRouter 免费保护：该模型已下线、价格变化或价格未确认，已阻止付费调用。请刷新模型列表并重新选择免费模型。'

export function protectOpenRouterPayload(payload: unknown, modelId: string): Record<string, unknown> {
  const source = objectValue(payload)
  if (source === undefined) throw new LlmError(FREE_ONLY_MESSAGE, 'OPENROUTER_FREE_ONLY')
  const result = { ...source }
  for (const key of ['models', 'route', 'router', 'preset', 'web_search_options', 'image_config', 'audio']) delete result[key]
  // No paid hosted search/file parsers/image generation, including defaults.
  result.model = modelId
  const pluginIds = new Set(['web', 'file-parser', 'response-healing', 'fusion', 'pareto-router', 'context-compression'])
  if (Array.isArray(source.plugins)) {
    for (const plugin of source.plugins) {
      const id = objectValue(plugin)?.id
      if (typeof id === 'string') pluginIds.add(id)
    }
  }
  result.plugins = [...pluginIds].map(id => ({ id, enabled: false }))
  result.modalities = ['text']
  result.provider = {
    ...objectValue(source.provider),
    allow_fallbacks: false,
    require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 },
  }
  if (Array.isArray(result.tools) && result.tools.some(tool => objectValue(tool)?.type !== 'function')) {
    throw new LlmError('OpenRouter 免费保护：免费调用不启用收费的服务端工具；请选择支持工具调用的免费模型。', 'OPENROUTER_FREE_ONLY')
  }
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      const content = objectValue(message)?.content
      if (Array.isArray(content) && content.some(part => !['text', 'image_url'].includes(String(objectValue(part)?.type)))) {
        throw new LlmError('OpenRouter 免费保护：仅支持文本和图片输入，不启用收费文件解析或音视频处理。', 'OPENROUTER_FREE_ONLY')
      }
    }
  }
  return result
}

export function prepareOpenRouterOptions<T extends StreamOptions>(
  model: Model<Api>,
  options: T,
  catalog?: OpenRouterCatalog,
): T & StreamOptions {
  // Also protect cached descriptors captured before a subsequent price change.
  const metadata = catalog?.model(model.id)
  const protectedAtStart = catalog?.protects(model.id) === true
    || model.id.endsWith(':free') || model.id === 'openrouter/free'
    || (metadata === undefined && model.cost.input === 0 && model.cost.output === 0)
  const defaultEffort = openRouterDefaultEffort(metadata)
  const existing = options.onPayload
  return {
    ...options,
    onPayload: async (payload: unknown, currentModel: Model<Api>) => {
      const result = await existing?.(payload, currentModel) ?? payload
      const data = objectValue(result)
      if (data !== undefined && metadata?.reasoningMandatory) {
        const reasoning = objectValue(data.reasoning)
        if (reasoning?.effort === undefined || reasoning.effort === 'none') {
          data.reasoning = { ...reasoning, effort: defaultEffort ?? 'high' }
        }
      }
      if (!protectedAtStart && catalog?.protects(model.id) !== true) return result
      const latest = catalog?.model(model.id)
      if (catalog?.models() !== undefined && latest?.priceStatus !== 'free') {
        throw new LlmError(FREE_ONLY_MESSAGE, 'OPENROUTER_FREE_ONLY')
      }
      return protectOpenRouterPayload(result, model.id)
    },
  }
}
