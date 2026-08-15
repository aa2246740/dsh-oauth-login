/** DSH-owned models.login() for every subscribed provider in the catalog. */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { requirePiLoginProvider } from './catalog.ts'
import { configureOAuthHttpTransport } from './http.ts'
import { catalogProvider } from './provider.ts'
import type { PiLoginSession } from './session.ts'
import { PiLoginCredentialStore } from './store.ts'

export interface PiLoginAuthStatus {
  providerId: string
  authenticated: boolean
  expiresAt?: Date
}

export async function loginPiProvider(
  providerId: string,
  interaction: AuthInteraction,
  store: PiLoginCredentialStore = new PiLoginCredentialStore(),
): Promise<void> {
  requirePiLoginProvider(providerId)
  await configureOAuthHttpTransport()
  const models = createModels({ credentials: store })
  models.setProvider(catalogProvider(providerId))
  await models.login(providerId, 'oauth', interaction)
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
    out.push(credential?.type === 'oauth'
      ? { providerId: id, authenticated: true, expiresAt: new Date(credential.expires) }
      : { providerId: id, authenticated: false })
  }
  return out
}

export async function loginPiProviderSession(
  providerId: string,
  interaction: AuthInteraction,
  session: PiLoginSession,
): Promise<void> {
  requirePiLoginProvider(providerId)
  await session.ensureTransport()
  session.models.setProvider(catalogProvider(providerId))
  await session.models.login(providerId, 'oauth', interaction)
}
