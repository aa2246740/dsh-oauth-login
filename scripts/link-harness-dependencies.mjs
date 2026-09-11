import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const root = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(join(root, 'tools/dshx/src/client-build.js'))) {
  throw new Error('Pass a prepared Harness checkout.')
}
const local = resolve('node_modules')
mkdirSync(local, { recursive: true })
const shared = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-api-session-controller': 'packages/api/session-controller',
  '@deepseek-ai/dsh-atomic-write': 'packages/util/atomic-write',
  '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment',
  '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection': 'packages/client/ui-model-selection',
  '@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
  '@deepseek-ai/dsh-client-ui-session': 'packages/client/ui-session',
  '@deepseek-ai/dsh-client-ui-settings': 'packages/client/ui-settings',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  '@deepseek-ai/dsh-invariants': 'packages/runtime-diagnostics/invariants',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-llm-pi-ai': 'packages/llm/llm-pi-ai',
  '@deepseek-ai/dsh-timeout': 'packages/util/timeout',
}
function replaceSymlinkWithDir(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  mkdirSync(path, { recursive: true })
}

function forceSymlink(destination, target) {
  try {
    unlinkSync(destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  symlinkSync(target, destination)
}

function link(name, target) {
  const destination = join(local, name)
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination)) {
    if (realpathSync(destination) !== realpathSync(target)) throw new Error(`Dependency mismatch: ${name}`)
    return
  }
  symlinkSync(target, destination)
}
for (const [name, path] of Object.entries(shared)) link(name, join(root, path))

const rootRequire = createRequire(join(root, 'package.json'))
const clientRequire = createRequire(join(root, 'packages/client/ui-conversation/package.json'))
link('@earendil-works/pi-ai', join(root, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai'))
link('undici', join(root, 'packages/web/web-fetch-http/node_modules/undici'))
replaceSymlinkWithDir(join(local, '@types'))
replaceSymlinkWithDir(join(local, '.bin'))
for (const name of ['@types/react', 'react']) link(name, dirname(clientRequire.resolve(`${name}/package.json`)))
for (const name of ['@types/node', 'tsdown', 'typescript', 'vitest']) {
  link(name, dirname(rootRequire.resolve(`${name}/package.json`)))
}
for (const name of ['tsdown', 'typescript', 'vitest']) {
  const pkg = JSON.parse(readFileSync(join(local, name, 'package.json'), 'utf8'))
  const bins = typeof pkg.bin === 'string' ? { [name]: pkg.bin } : pkg.bin
  for (const [command, path] of Object.entries(bins)) {
    forceSymlink(join(local, '.bin', command), join(local, name, path))
  }
}
console.log('Development dependencies linked to the selected Harness; no package download or Harness mutation.')
