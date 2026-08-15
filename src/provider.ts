/** Installed pi-ai providers remapped onto independent harness routes. */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Api, ApiKeyAuth, Model, Provider } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'

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
    throw new Error(`dsh-pi-login: the installed pi-ai catalog ships no "${id}" provider`)
  }
  return base
}

export function preferredModel(spec: PiLoginProvider, models: readonly { id: string }[] = catalogProvider(spec.id).getModels()): string {
  const ids = new Set(models.map(model => model.id))
  for (const candidate of spec.preferredModels) {
    if (ids.has(candidate)) return candidate
  }
  return models[0]?.id ?? spec.id
}

export function harnessProvider(spec: PiLoginProvider): Provider {
  const base = catalogProvider(spec.id)
  const models = (): Model<Api>[] => base.getModels().map(model => (
    model.provider === spec.route ? model : { ...model, provider: spec.route }
  ))
  return {
    id: spec.route,
    name: spec.displayName,
    ...base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl },
    auth: { ...base.auth, apiKey: harnessApiKeyAuth(spec.displayName) },
    getModels: models,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

export function allCatalogProviders(): Provider[] {
  return PI_LOGIN_PROVIDERS.map(spec => catalogProvider(spec.id))
}

export function allHarnessProviders(): Provider[] {
  return PI_LOGIN_PROVIDERS.map(spec => harnessProvider(spec))
}
