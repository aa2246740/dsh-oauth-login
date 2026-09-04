import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'tsdown'

const nodeExternal = [
  /^@deepseek-ai\//,
  /^@earendil-works\//,
  'react',
  'react/jsx-runtime',
]

const harness = process.env.DSHX_HARNESS
if (harness === undefined) throw new Error('Set DSHX_HARNESS to the checkout used for this build.')
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
