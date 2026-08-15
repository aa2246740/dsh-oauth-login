import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('bundle composition', () => {
  it('inserts llm-pi-login without forcing a default model', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: llm-pi-login')
    expect(patch).toContain('name: dsh-pi-login')
    expect(patch).not.toContain('agent-default-model')
  })

  it('declares a dsh bundle and web client half', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string }; client: { platform: string } }
    }
    expect(manifest.name).toBe('dsh-pi-login')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
  })
})
