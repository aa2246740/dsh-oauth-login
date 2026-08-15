/** Shared OAuth store + catalog for the host plugin and CLI. */

import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { allCatalogProviders, harnessProvider } from './provider.ts'
import { PiLoginCredentialStore } from './store.ts'

export class PiLoginSession {
  readonly store: PiLoginCredentialStore
  readonly models: MutableModels

  constructor(store: PiLoginCredentialStore = new PiLoginCredentialStore()) {
    this.store = store
    this.models = createModels({ credentials: store })
    for (const provider of allCatalogProviders()) this.models.setProvider(provider)
  }

  spec(id: string): PiLoginProvider {
    const spec = PI_LOGIN_PROVIDERS.find(provider => provider.id === id)
    if (spec === undefined) throw new Error(`dsh-pi-login: unknown provider "${id}"`)
    return spec
  }

  provider(id: string) {
    return harnessProvider(this.spec(id))
  }

  visibleModels(id: string) {
    return this.provider(id).getModels()
  }

  async logout(id: string): Promise<void> {
    await this.store.delete(id)
  }
}
