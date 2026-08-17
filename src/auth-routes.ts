/** Same-origin Web settings routes for Pi-native multi-provider OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginPiProviderSession, piLoginStatus } from './auth.ts'
import { PI_LOGIN_PROVIDERS, requirePiLoginProvider } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'
import type { PiLoginSession } from './session.ts'

export const PI_LOGIN_AUTH_STATUS_PATH = '/plugins/dsh-pi-login/auth/status'
export const PI_LOGIN_AUTH_LOGIN_PATH = '/plugins/dsh-pi-login/auth/login'
export const PI_LOGIN_AUTH_LOGOUT_PATH = '/plugins/dsh-pi-login/auth/logout'

export type PiLoginAccountState =
  | { status: 'signed-out' }
  | { status: 'signing-in'; url?: string; userCode?: string }
  | { status: 'signed-in'; models: string[]; expiresAt?: string }
  | { status: 'error'; message: string }

export interface PiLoginProviderStatus {
  id: string
  route: string
  displayName: string
  shortName: string
  account: PiLoginAccountState
}

export interface LoginChallenge {
  provider: string
  url: string
  userCode?: string
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

function answerWebPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === 'select') {
    const oauth = prompt.options.find(option => option.id === 'oauth' || option.id.includes('oauth'))
    const browser = prompt.options.find(option => option.id.includes('browser'))
    return Promise.resolve(oauth?.id ?? browser?.id ?? prompt.options[0]?.id ?? 'oauth')
  }
  if (prompt.type === 'text') return Promise.resolve('')
  return waitForPromptAbort(prompt)
}

class ProviderAuth {
  state: PiLoginAccountState = { status: 'signed-out' }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  constructor(
    private readonly spec: PiLoginProvider,
    private readonly session: PiLoginSession,
  ) {}

  async snapshot(): Promise<PiLoginAccountState> {
    if (this.operation !== undefined) return this.state
    if (this.state.status === 'error') return this.state
    return this.readStored()
  }

  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => {
      this.challengeWaiters.push({ resolve, reject })
    })
  }

  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('Pi login cancelled'))
    await this.operation?.catch(() => undefined)
    await this.session.logout(this.spec.id)
    this.state = { status: 'signed-out' }
    this.challenge = undefined
  }

  /** Wait until an in-flight sign-in settles (success or error). No-op if idle. */
  async waitUntilSettled(): Promise<void> {
    await this.operation?.catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('Pi login plugin disposed'))
    await this.operation?.catch(() => undefined)
  }

  private start(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.challenge = undefined
    this.state = { status: 'signing-in' }
    this.operation = loginPiProviderSession(this.spec.id, {
      signal: cancellation.signal,
      prompt: answerWebPrompt,
      notify: event => { this.onEvent(event) },
    }, this.session).then(
      async () => {
        this.state = await this.readStored()
      },
      (error: unknown) => {
        this.rejectChallenge(error)
        this.state = { status: 'error', message: safeMessage(error) }
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type === 'device_code') {
      this.acceptChallenge({
        provider: this.spec.id,
        url: event.verificationUri,
        ...event.userCode.length > 0 ? { userCode: event.userCode } : {},
      })
      return
    }
    if (event.type === 'auth_url') {
      this.acceptChallenge({ provider: this.spec.id, url: event.url })
    }
  }

  private acceptChallenge(challenge: LoginChallenge): void {
    if (!isSafeAuthUrl(challenge.url, this.spec)) {
      const error = new Error(`${this.spec.id} returned an authorization URL outside its official hosts`)
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    this.challenge = challenge
    this.state = {
      status: 'signing-in',
      url: challenge.url,
      ...challenge.userCode === undefined ? {} : { userCode: challenge.userCode },
    }
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge)
  }

  private async readStored(): Promise<PiLoginAccountState> {
    const [stored] = await piLoginStatus(this.session.store, this.spec.id)
    if (stored === undefined || !stored.authenticated) return { status: 'signed-out' }
    return {
      status: 'signed-in',
      models: this.session.visibleModels(this.spec.id).map(model => model.id),
      ...stored.expiresAt === undefined || Number.isNaN(stored.expiresAt.valueOf())
        ? {}
        : { expiresAt: stored.expiresAt.toISOString() },
    }
  }

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

export class PiLoginWebAuth {
  private readonly byId = new Map<string, ProviderAuth>()

  constructor(session: PiLoginSession) {
    for (const spec of PI_LOGIN_PROVIDERS) {
      this.byId.set(spec.id, new ProviderAuth(spec, session))
    }
  }

  private slot(id: string): ProviderAuth {
    const slot = this.byId.get(id)
    if (slot === undefined) throw new Error(`dsh-pi-login: unknown provider "${id}"`)
    return slot
  }

  async status(): Promise<PiLoginProviderStatus[]> {
    const out: PiLoginProviderStatus[] = []
    for (const spec of PI_LOGIN_PROVIDERS) {
      out.push({
        id: spec.id,
        route: spec.route,
        displayName: spec.displayName,
        shortName: spec.shortName,
        account: await this.slot(spec.id).snapshot(),
      })
    }
    return out
  }

  async signIn(id: string): Promise<LoginChallenge> {
    requirePiLoginProvider(id)
    return this.slot(id).signIn()
  }

  async signOut(id: string): Promise<void> {
    requirePiLoginProvider(id)
    await this.slot(id).signOut()
  }

  /** Wait until the named provider's in-flight sign-in settles. */
  async waitUntilSettled(id: string): Promise<void> {
    requirePiLoginProvider(id)
    await this.slot(id).waitUntilSettled()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.byId.values()].map(slot => slot.dispose()))
  }
}

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function providerIdFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('provider' in value) || typeof value.provider !== 'string') {
    throw new Error('expected { "provider": "<id>" }')
  }
  return requirePiLoginProvider(value.provider).id
}

export interface PiLoginAuthRouteOptions {
  /** Called after a successful sign-in or sign-out so the host can refresh LLM routes. */
  onAuthChanged?: () => void | Promise<void>
}

export function registerPiLoginAuthRoutes(
  ctx: Context,
  session: PiLoginSession,
  options: PiLoginAuthRouteOptions = {},
): void {
  const auth = new PiLoginWebAuth(session)
  const notifyAuthChanged = async (): Promise<void> => {
    await options.onAuthChanged?.()
  }
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            const challenge = await auth.signIn(providerIdFrom(await readJson(req)))
            // Login finishes in the browser; refresh LLM routes once the grant lands.
            void auth.waitUntilSettled(challenge.provider).then(async () => {
              await notifyAuthChanged()
            })
            json(res, 200, challenge)
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            await auth.signOut(providerIdFrom(await readJson(req)))
            await notifyAuthChanged()
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      await auth.dispose()
    }
  }, 'dsh-pi-login: Web OAuth routes')
}
