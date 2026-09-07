/** Installed pi-ai providers remapped onto independent harness routes. */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Api, ApiKeyAuth, Model, Provider } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { extraModelsFor } from './extra-models.ts'
import {
  DEFAULT_NATIVE_TOOL_POLICY,
  prepareNativeToolRequest,
} from './native-tools.ts'
import type { NativeToolPolicy } from './native-tools.ts'
import type { OpenRouterCatalog } from './openrouter-catalog.ts'
import { openRouterPiModel } from './openrouter-models.ts'
import { prepareOpenRouterOptions } from './openrouter-free.ts'

function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

export function catalogProvider(id: string): Provider {
  const base = builtinProviders().find(candidate => candidate.id === id)
  if (base === undefined) {
    throw new Error(`dsh-oauth-login: the installed pi-ai catalog ships no "${id}" provider`)
  }
  return base
}

/**
 * Catalog models plus plugin-owned extras, remapped onto the harness route.
 * Extras fill gaps the installed pi-ai version has not shipped yet (e.g. grok-4.6).
 */
/**
 * Prefer the extra's effort map when the installed catalog still lacks one.
 * Official OpenRouter generation currently sets `reasoning: true` and no map.
 */
function overlayExtraModel(model: Model<Api>, extra: Model<Api>): Model<Api> {
  const transport = model.provider === 'xai'
    && model.id === 'grok-4.6'
    && extra.api === 'openai-responses'
    ? { api: extra.api, compat: extra.compat }
    : {}
  const reasoning = extra.thinkingLevelMap !== undefined && model.thinkingLevelMap === undefined
    ? { reasoning: extra.reasoning, thinkingLevelMap: extra.thinkingLevelMap }
    : {}
  if (Object.keys(transport).length === 0 && Object.keys(reasoning).length === 0) return model
  return { ...model, ...transport, ...reasoning }
}

export function harnessModels(spec: PiLoginProvider, catalog?: OpenRouterCatalog): Model<Api>[] {
  const base = catalogProvider(spec.id).getModels()
  const extras = extraModelsFor(spec.id)
  const extraById = new Map(extras.map(model => [model.id, model]))
  const seen = new Set<string>()
  const merged: Model<Api>[] = []
  for (const model of base) {
    seen.add(model.id)
    const extra = extraById.get(model.id)
    merged.push(extra === undefined ? model : overlayExtraModel(model, extra))
  }
  for (const extra of extras) {
    if (seen.has(extra.id)) continue
    seen.add(extra.id)
    merged.push(extra)
  }
  const live = spec.id === 'openrouter' ? catalog?.models() : undefined
  const byId = new Map(merged.map(model => [model.id, model]))
  // A complete successful catalog replaces static discovery. Do not resurrect
  // removed endpoints from pi-ai/extras; a selected missing ID stays unselected.
  const models = live === undefined ? merged : live.map(info => openRouterPiModel(info, byId.get(info.id)))
  return models.map(model => (
    model.provider === spec.route ? model : { ...model, provider: spec.route }
  ))
}

export function preferredModel(
  spec: PiLoginProvider,
  models: readonly { id: string }[] = harnessModels(spec),
): string {
  const ids = new Set(models.map(model => model.id))
  for (const candidate of spec.preferredModels) {
    if (ids.has(candidate)) return candidate
  }
  return models[0]?.id ?? spec.id
}

export function harnessProvider(
  spec: PiLoginProvider,
  native: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
  catalog?: OpenRouterCatalog,
): Provider {
  const base = catalogProvider(spec.id)
  return {
    id: spec.route,
    name: spec.displayName,
    ...base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl },
    auth: { ...base.auth, apiKey: harnessApiKeyAuth(spec.displayName) },
    getModels: () => harnessModels(spec, catalog),
    stream: (model, context, options) => {
      const request = prepareNativeToolRequest(context, options ?? {}, spec.id, model.api, native)
      const guarded = spec.id === 'openrouter'
        ? prepareOpenRouterOptions(model, request.options, catalog) : request.options
      return base.stream(
        model,
        request.context,
        // pi-ai's generic ApiStreamOptions<T> is a conditional type. The
        // preparation step preserves every provider-specific field and only
        // adds StreamOptions.onPayload, but TypeScript cannot prove that for T.
        guarded as typeof options,
      )
    },
    streamSimple: (model, context, options) => {
      const request = prepareNativeToolRequest(context, options ?? {}, spec.id, model.api, native)
      const guarded = spec.id === 'openrouter'
        ? prepareOpenRouterOptions(model, request.options, catalog) : request.options
      return base.streamSimple(
        model,
        request.context,
        guarded,
      )
    },
  }
}

export function allCatalogProviders(): Provider[] {
  return PI_LOGIN_PROVIDERS.map(spec => catalogProvider(spec.id))
}

export function allHarnessProviders(): Provider[] {
  return PI_LOGIN_PROVIDERS.map(spec => harnessProvider(spec))
}
