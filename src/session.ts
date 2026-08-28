/** Shared OAuth store + catalog for the host plugin and CLI. */

import { dirname, join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS, piLoginProvider } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import type { OAuthProxyDiscoveryOptions, OAuthProxyResolution } from './http.ts'
import { PROXY_SETTINGS_FILENAME } from './proxy-config.ts'
import { OAuthProxyTransport } from './proxy-transport.ts'
import {
  grantNeedsRefresh,
  markRefreshAttempt,
  refreshAttemptKey,
  refreshGrant,
  refreshOnCooldown,
} from './oauth-refresh.ts'
import { DEFAULT_NATIVE_TOOL_POLICY } from './native-tools.ts'
import type { NativeToolPolicy } from './native-tools.ts'
import { allCatalogProviders, harnessModels, harnessProvider } from './provider.ts'
import { PiLoginCredentialStore } from './store.ts'
import { OPENROUTER_CACHE_FILENAME, OpenRouterCatalog } from './openrouter-catalog.ts'
import type { OpenRouterCatalogOptions } from './openrouter-catalog.ts'

export class PiLoginSession {
  readonly store: PiLoginCredentialStore
  readonly models: MutableModels
  readonly native: NativeToolPolicy
  readonly openRouter: OpenRouterCatalog
  readonly proxy: OAuthProxyTransport

  constructor(
    store: PiLoginCredentialStore = new PiLoginCredentialStore(),
    native: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
    catalogOptions: Partial<Pick<OpenRouterCatalogOptions, 'fetch' | 'now' | 'filename'>> = {},
    proxyDiscovery: OAuthProxyDiscoveryOptions = {},
  ) {
    this.store = store
    this.native = native
    this.proxy = new OAuthProxyTransport(join(dirname(store.filename), PROXY_SETTINGS_FILENAME), proxyDiscovery)
    this.models = createModels({ credentials: store })
    for (const provider of allCatalogProviders()) this.models.setProvider(provider)
    this.openRouter = new OpenRouterCatalog({
      filename: join(dirname(store.filename), OPENROUTER_CACHE_FILENAME),
      isAuthenticated: async () => (await store.list()).some(item => item.providerId === 'openrouter'),
      beforeFetch: () => this.ensureTransport(),
      fetch: (input, init) => this.proxy.run(() => fetch(input, init)),
      initiallyProtectedIds: harnessModels(this.spec('openrouter'))
        .filter(model => model.cost.input === 0 && model.cost.output === 0)
        .map(model => model.id),
      ...catalogOptions,
    })
  }

  ensureTransport(): Promise<OAuthProxyResolution> {
    return this.proxy.initialize()
  }

  spec(id: string): PiLoginProvider {
    const spec = piLoginProvider(id)
    if (spec === undefined) throw new Error(`dsh-oauth-login: unknown provider "${id}"`)
    return spec
  }

  provider(id: string) {
    return harnessProvider(this.spec(id), this.native, this.openRouter)
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
    if (id === 'openrouter') this.openRouter.disconnect()
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
      await this.proxy.run(() => refreshGrant(id => this.models.getAuth(id), providerId))
    }
  }
}
