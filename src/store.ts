/**
 * Multi-provider OAuth store. File is $DSH_HOME/.dsh-oauth-auth.json.
 * The old .pi-login-auth.json name is read only as a DSH-owned migration source.
 * Never ~/.codex, ~/.grok, ~/.claude, or ~/.pi/agent/auth.json.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PI_LOGIN_PROVIDERS } from './catalog.ts'
import { LEGACY_PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_FILENAME } from './ids.ts'

const AUTH_FORMAT_VERSION = 1
const ALLOWED_FIELDS = new Set([
  'type', 'access', 'refresh', 'expires', 'accountId', 'enterpriseUrl', 'availableModelIds',
])

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credentials: Record<string, OAuthCredential>
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  if (process.platform === 'win32') return
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `pi-login: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
}

function parseCredential(raw: unknown, filename: string, providerId: string): OAuthCredential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} must be an object`)
  }
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !ALLOWED_FIELDS.has(key))) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} contains an unknown field`)
  }
  if (credential['type'] !== 'oauth') {
    throw new Error(`pi-login: ${filename} credential for ${providerId} type must be oauth`)
  }
  if (typeof credential['access'] !== 'string' || credential['access'].length === 0) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} access must be a non-empty string`)
  }
  if (typeof credential['refresh'] !== 'string') {
    throw new Error(`pi-login: ${filename} credential for ${providerId} refresh must be a string`)
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} expires must be a positive finite number`)
  }
  return credential as unknown as OAuthCredential
}

function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`pi-login: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`pi-login: ${filename} must contain an object`)
  }
  const document = value as Record<string, unknown>
  if (document['version'] !== AUTH_FORMAT_VERSION) {
    throw new Error(`pi-login: ${filename} has unsupported auth format version ${String(document['version'])}`)
  }
  if (Object.keys(document).some(key => key !== 'version' && key !== 'credentials')) {
    throw new Error(`pi-login: ${filename} contains an unknown top-level field`)
  }
  const raw = document['credentials']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`pi-login: ${filename} credentials must be an object`)
  }
  const owned = new Set(PI_LOGIN_PROVIDERS.map(provider => provider.id))
  const credentials: Record<string, OAuthCredential> = {}
  for (const [providerId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!owned.has(providerId)) {
      throw new Error(`pi-login: ${filename} contains an unknown provider "${providerId}"`)
    }
    credentials[providerId] = parseCredential(entry, filename, providerId)
  }
  return { version: AUTH_FORMAT_VERSION, credentials }
}

function cloneCredential(credential: OAuthCredential): OAuthCredential {
  return structuredClone(credential)
}

export function piLoginAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), PI_LOGIN_AUTH_FILENAME))
}

export class PiLoginCredentialStore implements CredentialStore {
  readonly filename: string
  readonly legacyFilename: string | undefined

  constructor(filename: string = piLoginAuthPath()) {
    this.filename = resolve(filename)
    this.legacyFilename = basename(this.filename) === PI_LOGIN_AUTH_FILENAME
      ? resolve(join(dirname(this.filename), LEGACY_PI_LOGIN_AUTH_FILENAME))
      : undefined
  }

  private async readDocument(): Promise<AuthDocument> {
    const candidates = [this.filename, ...(this.legacyFilename === undefined ? [] : [this.legacyFilename])]
    for (const filename of candidates) {
      await assertOwnerOnly(filename)
      try {
        return parseDocument(await readFile(filename, 'utf8'), filename)
      } catch (error) {
        if (isENOENT(error)) continue
        throw error
      }
    }
    return { version: AUTH_FORMAT_VERSION, credentials: {} }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = (await this.readDocument()).credentials[providerId]
    return credential === undefined ? undefined : cloneCredential(credential)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.keys((await this.readDocument()).credentials).map(providerId => ({
      providerId,
      type: 'oauth' as const,
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (!PI_LOGIN_PROVIDERS.some(provider => provider.id === providerId)) {
      throw new Error(`pi-login: credential store does not own provider "${providerId}"`)
    }
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const document = await this.readDocument()
      const current = document.credentials[providerId]
      const candidate = await fn(current === undefined ? undefined : cloneCredential(current))
      if (candidate === undefined) return current === undefined ? undefined : cloneCredential(current)
      const next = parseCredential(candidate, this.filename, providerId)
      const credentials = { ...document.credentials, [providerId]: next }
      await writeFileAtomic(this.filename, `${JSON.stringify({ version: AUTH_FORMAT_VERSION, credentials }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return cloneCredential(next)
    })
  }

  async delete(providerId: string): Promise<void> {
    if (!PI_LOGIN_PROVIDERS.some(provider => provider.id === providerId)) return
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      const document = await this.readDocument()
      if (document.credentials[providerId] === undefined) return
      const { [providerId]: _removed, ...credentials } = document.credentials
      if (Object.keys(credentials).length === 0) {
        await rm(this.filename, { force: true })
        return
      }
      await writeFileAtomic(this.filename, `${JSON.stringify({ version: AUTH_FORMAT_VERSION, credentials }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }
}
