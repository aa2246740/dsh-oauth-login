/** Shared OAuth store + catalog for the host plugin and CLI. */

import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS, piLoginProvider } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { configureOAuthHttpTransport } from './http.ts'
import type { OAuthProxyResolution } from './http.ts'
import { allCatalogProviders, harnessProvider } from './provider.ts'
import { PiLoginCredentialStore } from './store.ts'

export class PiLoginSession {
  readonly store: PiLoginCredentialStore
  readonly models: MutableModels
  private transportPromise?: Promise<OAuthProxyResolution>

  constructor(store: PiLoginCredentialStore = new PiLoginCredentialStore()) {
    this.store = store
    this.models = createModels({ credentials: store })
    for (const provider of allCatalogProviders()) this.models.setProvider(provider)
  }

  ensureTransport(): Promise<OAuthProxyResolution> {
    if (this.transportPromise !== undefined) return this.transportPromise

    const pending = configureOAuthHttpTransport()
    this.transportPromise = pending
    void pending.catch(() => {
      if (this.transportPromise === pending) this.transportPromise = undefined
    })
    return pending
  }

  spec(id: string): PiLoginProvider {
    const spec = piLoginProvider(id)
    if (spec === undefined) throw new Error(`dsh-oauth-login: unknown provider "${id}"`)
    return spec
  }

  provider(id: string) {
    return harnessProvider(this.spec(id))
  }

  visibleModels(id: string) {
    return this.provider(id).getModels()
  }

  /**
   * Harness routes that currently hold a stored OAuth grant.
   * Model pickers should only advertise these — logging out must drop the route.
   */
  async authenticatedRoutes(): Promise<string[]> {
    const signedIn = new Set((await this.store.list()).map(item => item.providerId))
    return PI_LOGIN_PROVIDERS
      .filter(provider => signedIn.has(provider.id))
      .map(provider => provider.route)
  }

  async logout(id: string): Promise<void> {
    await this.store.delete(id)
  }
}
