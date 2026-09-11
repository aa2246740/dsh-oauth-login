/** Same-origin Web settings routes for Pi-native multi-provider OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginPiProviderSession, piLoginStatus } from './auth.ts'
import { PI_LOGIN_PROVIDERS, requirePiLoginProvider } from './catalog.ts'
import type { PiLoginProvider } from './catalog.ts'
import { isSafeAuthUrl, safeMessage } from './redact.ts'
import type { PiLoginSession } from './session.ts'
import { OPENROUTER_CATALOG_PATH, OPENROUTER_REFRESH_PATH } from './openrouter-types.ts'
import { parseProxySettings, PROXY_SETTINGS_PATH } from './proxy-config.ts'
import { ProxySettingsConflict } from './proxy-store.ts'

export const PI_LOGIN_AUTH_STATUS_PATH = '/plugins/dsh-oauth-login/auth/status'
export const PI_LOGIN_AUTH_LOGIN_PATH = '/plugins/dsh-oauth-login/auth/login'
export const PI_LOGIN_AUTH_CANCEL_PATH = '/plugins/dsh-oauth-login/auth/cancel'
export const PI_LOGIN_AUTH_COMPLETE_PATH = '/plugins/dsh-oauth-login/auth/complete'
export const PI_LOGIN_AUTH_LOGOUT_PATH = '/plugins/dsh-oauth-login/auth/logout'

export interface LoginInputChallenge {
  type: 'secret' | 'text' | 'manual_code'
  message: string
  placeholder?: string
}

type InputAuthPrompt = Extract<AuthPrompt, { type: 'secret' | 'text' | 'manual_code' }>

/** Preserve the Pi prompt discriminator on the browser wire contract. */
export function loginInputChallenge(prompt: InputAuthPrompt): LoginInputChallenge {
  return {
    type: prompt.type,
    message: prompt.message,
    ...'placeholder' in prompt && prompt.placeholder !== undefined
      ? { placeholder: prompt.placeholder }
      : {},
  }
}

export type PiLoginAccountState =
  | { status: 'signed-out' }
  | {
    status: 'signing-in'
    kind?: 'browser' | 'input'
    url?: string
    userCode?: string
    input?: LoginInputChallenge
  }
  | { status: 'signed-in'; models: string[]; expiresAt?: string }
  | { status: 'error'; message: string }

export interface PiLoginProviderStatus {
  id: string
  route: string
  displayName: string
  shortName: string
  authType: PiLoginProvider['authType']
  account: PiLoginAccountState
}

export interface LoginChallenge {
  provider: string
  kind: 'browser' | 'input'
  url?: string
  userCode?: string
  input?: LoginInputChallenge
}

/** Keep the browser authorization URL available while Pi also waits for a manual callback. */
export function mergeLoginChallenge(
  previous: LoginChallenge | undefined,
  next: LoginChallenge,
): LoginChallenge {
  return {
    ...next,
    ...next.url === undefined && previous?.url !== undefined ? { url: previous.url } : {},
    ...next.userCode === undefined && previous?.userCode !== undefined ? { userCode: previous.userCode } : {},
  }
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

function answerSelectPrompt(prompt: AuthPrompt): string | undefined {
  if (prompt.type === 'select') {
    const oauth = prompt.options.find(option => option.id === 'oauth' || option.id.includes('oauth'))
    const browser = prompt.options.find(option => option.id.includes('browser'))
    return oauth?.id ?? browser?.id ?? prompt.options[0]?.id ?? 'oauth'
  }
  return undefined
}

interface PendingInput {
  readonly operationId: number
  resolve(value: string): void
  reject(error: unknown): void
}

interface LoginOperation {
  readonly id: number
  readonly cancellation: AbortController
  readonly done: Promise<void>
  cancelled?: Error
  failure?: Error
  result?: PiLoginAccountState
  finish(): void
}

class ProviderAuth {
  state: PiLoginAccountState = { status: 'signed-out' }
  private operation: LoginOperation | undefined
  private nextOperationId = 0
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []
  private pendingInput: PendingInput | undefined

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
    const revision = this.nextOperationId
    const error = new Error('Pi login cancelled')
    this.stop(this.operation, error)
    await this.session.logout(this.spec.id)
    if (this.operation === undefined && this.nextOperationId === revision) {
      this.state = { status: 'signed-out' }
      this.challenge = undefined
    }
  }

  async cancel(): Promise<void> {
    const revision = this.nextOperationId
    const error = new Error('Pi login cancelled')
    this.stop(this.operation, error)
    const stored = await this.readStored()
    if (this.operation === undefined && this.nextOperationId === revision) {
      this.state = stored
      this.challenge = undefined
    }
  }

  async submitInput(value: string): Promise<PiLoginAccountState> {
    const pending = this.pendingInput
    if (pending === undefined) {
      throw new Error(`${this.spec.displayName} is not waiting for a credential`)
    }
    const normalized = value.trim()
    if (normalized.length === 0) throw new Error('credential must not be empty')
    if (normalized.length > 4096) throw new Error('credential is too long')
    const operation = this.operation
    if (operation === undefined || operation.id !== pending.operationId) {
      throw new Error(`${this.spec.displayName} login operation is no longer active`)
    }
    pending.resolve(normalized)
    await operation.done
    if (operation.cancelled !== undefined) throw operation.cancelled
    if (operation.failure !== undefined) throw operation.failure
    return operation.result ?? this.state
  }

  /** Wait until an in-flight sign-in settles (success or error). No-op if idle. */
  async waitUntilSettled(): Promise<void> {
    await this.operation?.done
  }

  async dispose(): Promise<void> {
    const error = new Error('Pi login plugin disposed')
    this.stop(this.operation, error)
  }

  private start(): void {
    const cancellation = new AbortController()
    const id = ++this.nextOperationId
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const operation: LoginOperation = { id, cancellation, done, finish }
    this.operation = operation
    this.challenge = undefined
    this.pendingInput = undefined
    this.state = { status: 'signing-in' }
    void loginPiProviderSession(this.spec.id, {
      signal: cancellation.signal,
      prompt: prompt => this.onPrompt(id, prompt),
      notify: event => { this.onEvent(id, event) },
    }, this.session).then(async () => {
      if (!this.isCurrent(id)) return
      const stored = await this.readStored()
      if (!this.isCurrent(id)) return
      operation.result = stored
      this.state = stored
    }).catch((error: unknown) => {
      if (!this.isCurrent(id)) return
      this.rejectChallenge(error)
      this.rejectInput(error)
      operation.failure = new Error(safeMessage(error))
      this.state = { status: 'error', message: operation.failure.message }
    }).finally(() => {
      if (this.isCurrent(id)) this.operation = undefined
      operation.finish()
    })
  }

  private onPrompt(operationId: number, prompt: AuthPrompt): Promise<string> {
    if (!this.isCurrent(operationId)) return Promise.reject(new Error('Pi login cancelled'))
    const selected = answerSelectPrompt(prompt)
    if (selected !== undefined) return Promise.resolve(selected)
    // Preserve the existing optional-text behavior in OAuth providers. Secret
    // and manual-code prompts require an explicit local user action.
    if (prompt.type === 'text' && this.spec.authType === 'oauth') return Promise.resolve('')
    if (prompt.type === 'secret' || prompt.type === 'manual_code' || prompt.type === 'text') {
      return this.requestInput(operationId, prompt)
    }
    return waitForPromptAbort(prompt)
  }

  private requestInput(operationId: number, prompt: InputAuthPrompt): Promise<string> {
    if (this.pendingInput !== undefined) {
      return Promise.reject(new Error(`${this.spec.displayName} already has a pending credential prompt`))
    }
    const input = loginInputChallenge(prompt)
    const operation = this.operation
    if (operation === undefined || operation.id !== operationId) return Promise.reject(new Error('Pi login cancelled'))
    const signals = [operation.cancellation.signal, prompt.signal]
      .filter((signal): signal is AbortSignal => signal !== undefined)
    const wait = new Promise<string>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        const signal = signals.find(candidate => candidate.aborted)
        settleReject(signal?.reason ?? new Error('credential prompt cancelled'))
      }
      const cleanup = (): void => {
        for (const signal of signals) signal.removeEventListener('abort', onAbort)
      }
      const settleResolve = (value: string): void => {
        if (settled) return
        settled = true
        cleanup()
        this.pendingInput = undefined
        resolve(value)
      }
      const settleReject = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        this.pendingInput = undefined
        reject(error)
      }
      this.pendingInput = { operationId, resolve: settleResolve, reject: settleReject }
      for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true })
      if (signals.some(signal => signal.aborted)) onAbort()
    })
    this.acceptChallenge({
      provider: this.spec.id,
      kind: 'input',
      ...this.spec.loginUrl === undefined ? {} : { url: this.spec.loginUrl },
      input,
    })
    return wait
  }

  private onEvent(operationId: number, event: AuthEvent): void {
    if (!this.isCurrent(operationId)) return
    if (event.type === 'device_code') {
      this.acceptChallenge({
        provider: this.spec.id,
        kind: 'browser',
        url: event.verificationUri,
        ...event.userCode.length > 0 ? { userCode: event.userCode } : {},
      })
      return
    }
    if (event.type === 'auth_url') {
      this.acceptChallenge({ provider: this.spec.id, kind: 'browser', url: event.url })
    }
  }

  private acceptChallenge(challenge: LoginChallenge): void {
    if (challenge.url !== undefined && !isSafeAuthUrl(challenge.url, this.spec)) {
      const error = new Error(`${this.spec.id} returned an authorization URL outside its official hosts`)
      this.stop(this.operation, error)
      return
    }
    const merged = mergeLoginChallenge(this.challenge, challenge)
    this.challenge = merged
    this.state = {
      status: 'signing-in',
      kind: merged.kind,
      ...merged.url === undefined ? {} : { url: merged.url },
      ...merged.userCode === undefined ? {} : { userCode: merged.userCode },
      ...merged.input === undefined ? {} : { input: merged.input },
    }
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(merged)
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

  private rejectInput(error: unknown): void {
    this.pendingInput?.reject(error)
  }

  private isCurrent(operationId: number): boolean {
    return this.operation?.id === operationId
  }

  private stop(operation: LoginOperation | undefined, error: Error): void {
    if (operation === undefined || this.operation?.id !== operation.id) return
    this.operation = undefined
    operation.cancelled = error
    this.rejectChallenge(error)
    this.rejectInput(error)
    operation.cancellation.abort(error)
    operation.finish()
  }
}

export class PiLoginWebAuth {
  private readonly session: PiLoginSession
  private readonly byId = new Map<string, ProviderAuth>()

  constructor(session: PiLoginSession) {
    this.session = session
    for (const spec of PI_LOGIN_PROVIDERS) {
      this.byId.set(spec.id, new ProviderAuth(spec, session))
    }
  }

  private slot(id: string): ProviderAuth {
    const slot = this.byId.get(id)
    if (slot === undefined) throw new Error(`dsh-oauth-login: unknown provider "${id}"`)
    return slot
  }

  async status(): Promise<PiLoginProviderStatus[]> {
    await this.session.refreshStoredGrants()
    await this.session.openRouter.syncAuthentication()
    const out: PiLoginProviderStatus[] = []
    for (const spec of PI_LOGIN_PROVIDERS) {
      out.push({
        id: spec.id,
        route: spec.route,
        displayName: spec.displayName,
        shortName: spec.shortName,
        authType: spec.authType,
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

  async cancel(id: string): Promise<void> {
    requirePiLoginProvider(id)
    await this.slot(id).cancel()
  }

  async submitInput(id: string, value: string): Promise<PiLoginAccountState> {
    requirePiLoginProvider(id)
    return this.slot(id).submitInput(value)
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

function trustedProxyRequest(req: IncomingMessage): boolean {
  if (!trustedRequest(req)) return false
  // A proxy endpoint controls where credentials travel. Reject a rebound
  // public hostname even when its connection happens to originate on loopback.
  try {
    const host = new URL(`http://${req.headers.host}`).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch { return false }
}

function rejectWebRequest(ctx: Context, req: IncomingMessage, res: ServerResponse, proxy = false): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return true
  }
  if (proxy ? !trustedProxyRequest(req) : !trustedRequest(req)) {
    json(res, 403, { error: 'forbidden' })
    return true
  }
  return false
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

function providerInputFrom(value: unknown): { providerId: string; value: string } {
  if (
    typeof value !== 'object'
    || value === null
    || !('provider' in value)
    || typeof value.provider !== 'string'
    || !('value' in value)
    || typeof value.value !== 'string'
  ) {
    throw new Error('expected { "provider": "<id>", "value": "<credential>" }')
  }
  return {
    providerId: requirePiLoginProvider(value.provider).id,
    value: value.value,
  }
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
        path: PROXY_SETTINGS_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res, true)) return
          if (req.method === 'GET') {
            try { return json(res, 200, await session.proxy.settings.read()) } catch {
              return json(res, 503, { error: 'Network settings could not be read' })
            }
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
            return json(res, 415, { error: 'application/json required' })
          }
          let settings
          try { settings = parseProxySettings(await readJson(req)) } catch {
            return json(res, 400, { error: 'Invalid network settings: use HTTP(S) proxy URLs without credentials or paths' })
          }
          try { json(res, 200, await session.proxy.save(settings)) } catch (error) {
            if (error instanceof ProxySettingsConflict) return json(res, 409, { error: error.message })
            json(res, 503, { error: 'Network settings could not be saved' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENROUTER_CATALOG_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          try {
            await session.openRouter.syncAuthentication()
            json(res, 200, session.openRouter.snapshot())
          } catch {
            json(res, 503, { error: 'OpenRouter model catalog unavailable' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENROUTER_REFRESH_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            await session.openRouter.syncAuthentication()
            if (!session.openRouter.snapshot().connected) {
              return json(res, 409, { error: 'Sign in to OpenRouter first' })
            }
            await session.openRouter.refresh(true)
            json(res, 200, session.openRouter.snapshot())
          } catch {
            json(res, 503, { error: 'OpenRouter model catalog unavailable' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const challenge = await auth.signIn(providerIdFrom(await readJson(req)))
            if (challenge.kind === 'browser') {
              // OAuth finishes in the browser; refresh LLM routes once the grant lands.
              void auth.waitUntilSettled(challenge.provider).then(async () => {
                await notifyAuthChanged()
              })
            }
            json(res, 200, challenge)
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_CANCEL_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            await auth.cancel(providerIdFrom(await readJson(req)))
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_COMPLETE_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const submission = providerInputFrom(await readJson(req))
            const account = await auth.submitInput(submission.providerId, submission.value)
            await notifyAuthChanged()
            json(res, 200, { ok: true, account })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PI_LOGIN_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (rejectWebRequest(ctx, req, res)) return
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
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
  }, 'dsh-oauth-login: Web OAuth routes')
}
