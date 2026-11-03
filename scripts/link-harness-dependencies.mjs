import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const requested = process.argv[2] || process.env.DSH_REPO
const root = resolve(requested || '')
if (!requested || !existsSync(join(root, 'tools/dshx/src/client-build.js'))) {
  throw new Error('Pass a prepared Harness checkout, or set DSH_REPO.')
}
const local = resolve('node_modules')
mkdirSync(local, { recursive: true })
const shared = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-api-session-controller': 'packages/api/session-controller',
  '@deepseek-ai/dsh-atomic-write': 'packages/util/atomic-write',
  '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment',
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection': 'packages/client/ui-model-selection',
  '@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
  '@deepseek-ai/dsh-client-ui-session': 'packages/client/ui-session',
  '@deepseek-ai/dsh-client-ui-settings': 'packages/client/ui-settings',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
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
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
function declaredTypesExist(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const types = typeof manifest.types === 'string'
    ? manifest.types
    : manifest.exports?.['.']?.types
  return typeof types !== 'string' || existsSync(join(pkgDir, types))
}
function builtPackage(name) {
  const runtime = process.env.DSH_RUNTIME || join(dirname(root), 'runtime-rc5')
  const direct = join(runtime, 'node_modules', name)
  if (existsSync(join(direct, 'package.json')) && declaredTypesExist(direct)) return direct
  const store = join(runtime, 'node_modules/.pnpm')
  if (!existsSync(store)) return undefined
  const slug = `${name.replace('/', '+')}@`
  const match = readdirSync(store).find(entry => entry.startsWith(slug))
  if (!match) return undefined
  const pkgDir = join(store, match, 'node_modules', name)
  return existsSync(join(pkgDir, 'package.json')) && declaredTypesExist(pkgDir) ? pkgDir : undefined
}
function link(name, target) {
  if (!existsSync(target)) throw new Error(`Missing Harness dependency: ${name} (${target})`)
  const destination = join(local, name)
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination) || isSymlink(destination)) {
    if (existsSync(destination) && realpathSync(destination) === realpathSync(target)) return
    rmSync(destination, { recursive: true, force: true })
  }
  symlinkSync(target, destination)
}
for (const [name, path] of Object.entries(shared)) {
  const source = join(root, path)
  const target = declaredTypesExist(source) ? source : (builtPackage(name) ?? source)
  link(name, target)
}
const removedInvariants = join(local, '@deepseek-ai/dsh-invariants')
if (isSymlink(removedInvariants) || existsSync(removedInvariants)) {
  rmSync(removedInvariants, { recursive: true, force: true })
}
const rootRequire = createRequire(join(root, 'package.json'))
const clientRequire = createRequire(join(root, 'packages/client/ui-conversation/package.json'))
link('@earendil-works/pi-ai', join(root, 'node_modules/@earendil-works/pi-ai'))
const undiciNested = join(root, 'packages/web/web-fetch-http/node_modules/undici')
link('undici', existsSync(undiciNested) ? undiciNested : join(root, 'node_modules/undici'))
replaceSymlinkWithDir(join(local, '@types'))
replaceSymlinkWithDir(join(local, '.bin'))
for (const name of ['@types/react', 'react']) {
  let target
  try {
    target = dirname(clientRequire.resolve(`${name}/package.json`))
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    console.warn(`Harness checkout has no ${name}; keeping the plugin copy.`)
    continue
  }
  link(name, target)
}
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
