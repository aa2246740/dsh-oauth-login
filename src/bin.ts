#!/usr/bin/env node
/** Standalone credential CLI. Never reads or writes official CLI auth files. */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import { PI_LOGIN_PROVIDERS, requirePiLoginProvider } from './catalog.ts'
import {
  loginPiProviderSession,
  piLoginAuthPath,
  piLoginStatus,
  PiLoginSession,
} from './index.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'

type Action = 'login' | 'logout' | 'status'

function openBrowser(rawUrl: string, providerId: string): void {
  const spec = requirePiLoginProvider(providerId)
  if (!isSafeAuthUrl(rawUrl, spec)) {
    throw new Error(`refusing to open authorization URL outside ${spec.displayName} official hosts`)
  }
  const url = new URL(rawUrl)
  const command = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url.href] }
      : { file: 'xdg-open', args: [url.href] }
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // printed URL remains the fallback
  }
}

function notify(event: AuthEvent, providerId: string, useBrowser: boolean): void {
  switch (event.type) {
    case 'auth_url':
      process.stdout.write(`Open this URL to sign in:\n${event.url}\n`)
      if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`)
      if (useBrowser) openBrowser(event.url, providerId)
      break
    case 'device_code':
      process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\n`)
      if (event.userCode.length > 0) process.stdout.write(`Enter code: ${event.userCode}\n`)
      if (useBrowser) openBrowser(event.verificationUri, providerId)
      break
    case 'info':
    case 'progress':
      process.stdout.write(`${event.message}\n`)
      break
    default:
      event satisfies never
  }
}

async function answerPrompt(
  prompt: AuthPrompt,
  question: (text: string, options: { signal?: AbortSignal }) => Promise<string>,
): Promise<string> {
  if (prompt.type === 'select') {
    const oauth = prompt.options.find(option => option.id === 'oauth' || option.id.includes('oauth'))
    const browser = prompt.options.find(option => option.id.includes('browser'))
    return oauth?.id ?? browser?.id ?? prompt.options[0]?.id ?? 'oauth'
  }
  const suffix = prompt.placeholder === undefined ? '' : ` (${prompt.placeholder})`
  return question(`${prompt.message}${suffix}: `, {
    ...prompt.signal === undefined ? {} : { signal: prompt.signal },
  })
}

function printHelp(): void {
  const ids = PI_LOGIN_PROVIDERS.map(provider => `    ${provider.id.padEnd(18)} ${provider.displayName}`).join('\n')
  process.stdout.write([
    'Usage: dsh-oauth-login <login|logout|status> [provider]',
    '',
    '  login [provider]   Pi-native OAuth. Own file, not official CLIs',
    '  logout [provider]  remove a dsh credential (or all if omitted)',
    '  status [provider]  report non-secret credential state',
    '',
    'Providers:',
    ids,
    '',
  ].join('\n'))
}

function resolveIds(raw: string | undefined): string[] {
  if (raw === undefined) return PI_LOGIN_PROVIDERS.map(provider => provider.id)
  return [requirePiLoginProvider(raw).id]
}

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, rawProvider, ...rest] = argv
  if (rawAction !== 'login' && rawAction !== 'logout' && rawAction !== 'status') {
    process.stderr.write(`dsh-oauth-login: expected login, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  if (rest.length > 0) {
    process.stderr.write(`dsh-oauth-login: unexpected extra arguments: ${rest.join(' ')}\n`)
    return 1
  }
  const action: Action = rawAction
  try {
    const session = new PiLoginSession()
    switch (action) {
      case 'status': {
        const ids = resolveIds(rawProvider)
        let failed = false
        process.stdout.write(`store: ${piLoginAuthPath()}\n`)
        await session.refreshStoredGrants()
        for (const id of ids) {
          const [status] = await piLoginStatus(session.store, id)
          const spec = requirePiLoginProvider(id)
          if (status === undefined || !status.authenticated) {
            process.stdout.write(`${spec.displayName}: signed out\n`)
            failed = true
            continue
          }
          const expires = status.expiresAt
          const suffix = expires === undefined || Number.isNaN(expires.valueOf())
            ? ''
            : `; access expires ${expires.toISOString()}`
          const models = session.visibleModels(id).map(model => model.id).slice(0, 8).join(', ')
          process.stdout.write(`${spec.displayName}: signed in${suffix}\n`)
          process.stdout.write(`  route: ${spec.route}\n`)
          process.stdout.write(`  models: ${models}\n`)
        }
        return failed && rawProvider !== undefined ? 1 : 0
      }
      case 'logout': {
        const ids = resolveIds(rawProvider)
        for (const id of ids) {
          await session.logout(id)
          process.stdout.write(`${requirePiLoginProvider(id).displayName}: signed out\n`)
        }
        process.stdout.write('Official CLI auth files were not touched.\n')
        return 0
      }
      case 'login': {
        if (rawProvider === undefined) {
          process.stderr.write('dsh-oauth-login: login requires a provider id (see --help)\n')
          return 1
        }
        const id = requirePiLoginProvider(rawProvider).id
        const readline = createInterface({ input: process.stdin, output: process.stdout })
        try {
          await loginPiProviderSession(id, {
            prompt: prompt => answerPrompt(prompt, (text, options) => readline.question(text, options)),
            notify: event => notify(event, id, true),
          }, session)
        } finally {
          readline.close()
        }
        process.stdout.write(`${requirePiLoginProvider(id).displayName}: signed in\n`)
        process.stdout.write(`store: ${piLoginAuthPath()}\n`)
        process.stdout.write('Official CLI auth files were not read or written.\n')
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-oauth-login: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
