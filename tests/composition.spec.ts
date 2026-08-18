import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('bundle composition', () => {
  it('inserts llm-oauth-login without forcing a default model', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: llm-oauth-login')
    expect(patch).toContain('name: dsh-oauth-login')
    expect(patch).not.toContain('agent-default-model')
  })

  it('keeps a portable dshx workshop overlay and boot marker', async () => {
    const [manifest, overlay, entry] = await Promise.all([
      readFile(join(root, 'dshx.yml'), 'utf8'),
      readFile(join(root, 'cordis.yml'), 'utf8'),
      readFile(join(root, 'src/index.ts'), 'utf8'),
    ])
    expect(manifest).toContain('id: llm-oauth-login')
    expect(manifest).toContain('marker: "[my-plugins/dsh-oauth-login] loaded"')
    expect(overlay).toContain('id: llm-oauth-login')
    expect(overlay).toContain("name: './src/index.ts'")
    expect(overlay).not.toMatch(/\/workspace\/|\/home\//)
    expect(entry).toContain('[my-plugins/dsh-oauth-login] loaded')
    expect(entry).not.toMatch(/export\s+default\s+/)
  })

  it('declares a dsh bundle and web client half', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string }; client: { platform: string } }
    }
    expect(manifest.name).toBe('dsh-oauth-login')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
  })
})
