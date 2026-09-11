/**
 * Multi-provider subscription credential store. File is $DSH_HOME/.dsh-oauth-auth.json.
 * The old .pi-login-auth.json name is read only as a DSH-owned migration source.
 * Never ~/.codex, ~/.grok, ~/.claude, or ~/.pi/agent/auth.json.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, ProviderEnv } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PI_LOGIN_PROVIDERS } from './catalog.ts'
import { LEGACY_PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_FILENAME } from './ids.ts'

const AUTH_FORMAT_VERSION = 1
const OAUTH_ALLOWED_FIELDS = new Set([
  'type', 'access', 'refresh', 'expires', 'accountId', 'enterpriseUrl', 'availableModelIds',
])
const API_KEY_ALLOWED_FIELDS = new Set(['type', 'key', 'env'])

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credentials: Record<string, Credential>
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

function parseProviderEnv(raw: unknown, filename: string, providerId: string): ProviderEnv | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} env must be an object`)
  }
  const env: ProviderEnv = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`pi-login: ${filename} credential for ${providerId} env values must be strings`)
    }
    env[key] = value
  }
  return env
}

function parseCredential(raw: unknown, filename: string, providerId: string): Credential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} must be an object`)
  }
  const credential = raw as Record<string, unknown>
  const type = credential['type']
  const allowed = type === 'oauth'
    ? OAUTH_ALLOWED_FIELDS
    : type === 'api_key'
      ? API_KEY_ALLOWED_FIELDS
      : undefined
  if (allowed === undefined) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} type must be oauth or api_key`)
  }
  if (Object.keys(credential).some(key => !allowed.has(key))) {
    throw new Error(`pi-login: ${filename} credential for ${providerId} contains an unknown field`)
  }
  if (type === 'api_key') {
    if (typeof credential['key'] !== 'string' || credential['key'].length === 0) {
      throw new Error(`pi-login: ${filename} credential for ${providerId} key must be a non-empty string`)
    }
    const env = parseProviderEnv(credential['env'], filename, providerId)
    return {
      type: 'api_key',
      key: credential['key'],
      ...(env === undefined ? {} : { env }),
    }
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
  return credential as unknown as Credential
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
  const credentials: Record<string, Credential> = {}
  for (const [providerId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!owned.has(providerId)) {
      throw new Error(`pi-login: ${filename} contains an unknown provider "${providerId}"`)
    }
    credentials[providerId] = parseCredential(entry, filename, providerId)
  }
  return { version: AUTH_FORMAT_VERSION, credentials }
}

function cloneCredential(credential: Credential): Credential {
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

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()
    const credential = (await this.readDocument()).credentials[providerId]
    options?.signal?.throwIfAborted()
    return credential === undefined ? undefined : cloneCredential(credential)
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()
    const document = await this.readDocument()
    options?.signal?.throwIfAborted()
    return Object.entries(document.credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (!PI_LOGIN_PROVIDERS.some(provider => provider.id === providerId)) {
      throw new Error(`pi-login: credential store does not own provider "${providerId}"`)
    }
    options?.signal?.throwIfAborted()
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    options?.signal?.throwIfAborted()
    return withFileLock(this.filename, async () => {
      options?.signal?.throwIfAborted()
      const document = await this.readDocument()
      options?.signal?.throwIfAborted()
      const current = document.credentials[providerId]
      const candidate = await fn(current === undefined ? undefined : cloneCredential(current))
      options?.signal?.throwIfAborted()
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

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (!PI_LOGIN_PROVIDERS.some(provider => provider.id === providerId)) return
    options?.signal?.throwIfAborted()
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    options?.signal?.throwIfAborted()
    await withFileLock(this.filename, async () => {
      options?.signal?.throwIfAborted()
      const document = await this.readDocument()
      options?.signal?.throwIfAborted()
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
