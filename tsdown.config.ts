import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const nodeExternal = [
  /^@deepseek-ai\//,
  /^@earendil-works\//,
  'react',
  'react/jsx-runtime',
]

const vendored = fileURLToPath(new URL('./tools/client-build.js', import.meta.url))

function resolveHarnessAdapter(): string {
  const configured = process.env.DSHX_HARNESS?.trim()
  const configPath = join(homedir(), '.config/dshx/harness')
  const recorded = existsSync(configPath) ? readFileSync(configPath, 'utf8').trim() : undefined
  const root = configured ? resolve(configured) : recorded ? resolve(recorded) : undefined
  if (!root) {
    throw new Error('dshx client build requires a Harness root from DSHX_HARNESS or ~/.config/dshx/harness')
  }
  return join(root, 'tools/dshx/src/client-build.js')
}

const adapter = existsSync(vendored) ? vendored : resolveHarnessAdapter()
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
