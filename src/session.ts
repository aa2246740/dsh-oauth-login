/** Shared OAuth store + catalog for the host plugin and CLI. */

import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS, piLoginProvider } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { configureOAuthHttpTransport } from './http.ts'
import type { OAuthProxyResolution } from './http.ts'
import {
  grantNeedsRefresh,
  markRefreshAttempt,
  refreshAttemptKey,
  refreshGrant,
  refreshOnCooldown,
} from './oauth-refresh.ts'
import { DEFAULT_NATIVE_TOOL_POLICY } from './native-tools.ts'
import type { NativeToolPolicy } from './native-tools.ts'
import { allCatalogProviders, harnessProvider } from './provider.ts'
import { PiLoginCredentialStore } from './store.ts'

export class PiLoginSession {
  readonly store: PiLoginCredentialStore
  readonly models: MutableModels
  readonly native: NativeToolPolicy
  private transportPromise?: Promise<OAuthProxyResolution>

  constructor(
    store: PiLoginCredentialStore = new PiLoginCredentialStore(),
    native: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
  ) {
    this.store = store
    this.native = native
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
    return harnessProvider(this.spec(id), this.native)
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

  /**
   * Renew access tokens that are expired or close to expiry.
   * Failures stay in the store; the next poll or chat retries.
   */
  async refreshStoredGrants(now = Date.now()): Promise<void> {
    await this.ensureTransport()
    for (const { providerId } of await this.store.list()) {
      const credential = await this.store.read(providerId)
      if (credential?.type !== 'oauth' || !grantNeedsRefresh(credential.expires, now)) continue
      const key = refreshAttemptKey(this.store.filename, providerId)
      if (refreshOnCooldown(key, now)) continue
      markRefreshAttempt(key, now)
      await refreshGrant(id => this.models.getAuth(id), providerId)
    }
  }
}
