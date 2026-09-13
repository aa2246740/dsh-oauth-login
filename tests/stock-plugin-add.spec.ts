import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  main: string
  scripts?: { prepare?: string }
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string } }
}

describe('stock dsh plugin add', () => {
  it('declares dsh.bundle.patch so official add joins the profile layer stack', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(root, 'cordis.patch.yml'))).toBe(true)
  })

  it('commits compiled lib entries and does not require a prepare script', () => {
    expect(pkg.scripts?.prepare).toBeUndefined()
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(existsSync(resolve(root, 'lib/index.js'))).toBe(true)
    expect(existsSync(resolve(root, 'lib/client.js'))).toBe(true)
  })

  it('leads the README with the official github: add', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const english = readFileSync(resolve(root, 'README.en.md'), 'utf8')
    const command = 'dsh plugin --profile web add github:aa2246740/dsh-oauth-login'
    expect(readme.indexOf(command)).toBeLessThan(readme.indexOf('把 ChatGPT'))
    expect(english.indexOf(command)).toBeLessThan(english.indexOf('OAuth login'))
  })
})
