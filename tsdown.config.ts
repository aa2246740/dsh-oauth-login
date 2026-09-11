import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'tsdown'

const nodeExternal = [
  /^@deepseek-ai\//,
  /^@earendil-works\//,
  'react',
  'react/jsx-runtime',
]

function resolveHarness(): string {
  const configured = process.env.DSHX_HARNESS?.trim()
  if (configured) return resolve(configured)
  const configPath = join(homedir(), '.config/dshx/harness')
  const recorded = existsSync(configPath) ? readFileSync(configPath, 'utf8').trim() : undefined
  if (!recorded) {
    throw new Error('dshx client build requires a Harness root from DSHX_HARNESS or ~/.config/dshx/harness')
  }
  return resolve(recorded)
}

const harness = resolveHarness()
const adapter = resolve(harness, 'tools/dshx/src/client-build.js')
if (!existsSync(adapter)) throw new Error('DSHX externalClientBundle adapter is missing.')
const { externalClientBundle } = await import(pathToFileURL(adapter).href)
const client = externalClientBundle('dsh-oauth-login', [], { clientEntry: 'src/client/index.tsx' })[1]

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
    },
    platform: 'node',
    format: 'esm',
    dts: true,
    outDir: 'lib',
    fixedExtension: false,
    deps: { neverBundle: nodeExternal },
  },
  {
    entry: {
      bin: 'src/bin.ts',
    },
    platform: 'node',
    format: 'esm',
    dts: true,
    outDir: 'lib',
    fixedExtension: false,
    deps: { neverBundle: nodeExternal },
  },
  client,
])
