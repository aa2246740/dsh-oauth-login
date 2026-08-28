/** DSH-owned models.login() for every subscribed provider in the catalog. */

import { createModels } from '@earendil-works/pi-ai'
import { dirname, join } from 'node:path'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { requirePiLoginProvider } from './catalog.ts'
import { OAuthProxyTransport } from './proxy-transport.ts'
import { PROXY_SETTINGS_FILENAME } from './proxy-config.ts'
import { catalogProvider } from './provider.ts'
import type { PiLoginSession } from './session.ts'
import { PiLoginCredentialStore } from './store.ts'

export interface PiLoginAuthStatus {
  providerId: string
  authenticated: boolean
  credentialType?: 'oauth' | 'api_key'
  expiresAt?: Date
}

export async function loginPiProvider(
  providerId: string,
  interaction: AuthInteraction,
  store: PiLoginCredentialStore = new PiLoginCredentialStore(),
): Promise<void> {
  const spec = requirePiLoginProvider(providerId)
  const models = createModels({ credentials: store })
  models.setProvider(catalogProvider(providerId))
  const proxy = new OAuthProxyTransport(join(dirname(store.filename), PROXY_SETTINGS_FILENAME))
  try { await proxy.run(() => models.login(providerId, spec.authType, interaction)) } finally { await proxy.dispose() }
}

export async function logoutPiProvider(
  providerId: string,
  store: PiLoginCredentialStore = new PiLoginCredentialStore(),
): Promise<void> {
  requirePiLoginProvider(providerId)
  await store.delete(providerId)
}

export async function piLoginStatus(
  store: PiLoginCredentialStore = new PiLoginCredentialStore(),
  providerId?: string,
): Promise<PiLoginAuthStatus[]> {
  const ids = providerId === undefined ? (await store.list()).map(item => item.providerId) : [providerId]
  const out: PiLoginAuthStatus[] = []
  for (const id of ids) {
    const credential = await store.read(id)
    if (credential?.type === 'oauth') {
      out.push({
        providerId: id,
        authenticated: true,
        credentialType: 'oauth',
        expiresAt: new Date(credential.expires),
      })
      continue
    }
    if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.length > 0) {
      out.push({ providerId: id, authenticated: true, credentialType: 'api_key' })
      continue
    }
    out.push({ providerId: id, authenticated: false })
  }
  return out
}

export async function loginPiProviderSession(
  providerId: string,
  interaction: AuthInteraction,
  session: PiLoginSession,
): Promise<void> {
  const spec = requirePiLoginProvider(providerId)
  await session.ensureTransport()
  session.models.setProvider(catalogProvider(providerId))
  await session.proxy.run(() => session.models.login(providerId, spec.authType, interaction))
  if (providerId === 'openrouter') await session.openRouter.syncAuthentication('login')
}
