/** Independent, atomic settings file; never writes the OAuth credential document. */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defaultProxySettings, parseProxySettings } from './proxy-config.ts'
import type { ProxySettingsSnapshot } from './proxy-config.ts'

export class ProxySettingsConflict extends Error {}

export class ProxySettingsStore {
  constructor(readonly filename: string) {}

  async read(): Promise<ProxySettingsSnapshot> {
    let text: string
    try { text = await readFile(this.filename, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultProxySettings()
      throw new Error('Network settings could not be read', { cause: error })
    }
    let document: unknown
    try { document = JSON.parse(text) } catch { throw new Error('Network settings file is not valid JSON') }
    if (typeof document !== 'object' || document === null || !('version' in document)
      || document.version !== 1 || !('settings' in document)
      || Object.keys(document).some(key => key !== 'version' && key !== 'settings')) {
      throw new Error('Unsupported network settings file')
    }
    return parseProxySettings(document.settings)
  }

  async save(value: unknown): Promise<ProxySettingsSnapshot> {
    const input = parseProxySettings(value)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const current = await this.read()
      if (current.revision !== input.revision) {
        throw new ProxySettingsConflict('Network settings changed. Reload them before saving.')
      }
      const settings = { ...input, revision: current.revision + 1 }
      await writeFileAtomic(this.filename, `${JSON.stringify({ version: 1, settings }, null, 2)}\n`, {
        mode: 0o600, dirMode: 0o700,
      })
      return settings
    })
  }
}
