import { LlmFailure, RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Api, AuthInteraction, Credential, CredentialInfo, CredentialStore, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/plugin-config.d.ts
/**
 * `retryPolicy` is executed by shipped `dsh-llm-retry`, not by this plugin.
 * Omission keeps the official normal default (2 retries for TIMEOUT /
 * TRANSPORT / SERVER / RATE_LIMIT / EMPTY_RESPONSE).
 */
interface Config {
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
}
declare const Config: z<Config>;
//#endregion
//#region src/catalog.d.ts
/** OAuth subscriptions Pi Agent exposes via /login. Radius is omitted (needs a gateway). */
interface PiLoginProvider {
  /** pi-ai provider id used by models.login(). */
  readonly id: string;
  /** Harness LLM route. Distinct from catalog routes and from other plugins. */
  readonly route: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly blurb: string;
  readonly blurbZh: string;
  /** HTTPS hosts this provider is allowed to open during login. */
  readonly allowedHosts: readonly string[];
  /** Extra allowed host suffixes (leading-dot match). */
  readonly allowedSuffixes: readonly string[];
  readonly preferredModels: readonly string[];
}
declare const PI_LOGIN_PROVIDERS: readonly PiLoginProvider[];
declare function piLoginProvider(id: string): PiLoginProvider | undefined;
declare function piLoginRoutes(): string[];
//#endregion
//#region src/http.d.ts
/** Proxy-aware HTTP transport for OAuth and subscribed-provider requests. */
type OAuthProxyResolution = {
  source: 'environment';
} | {
  source: 'explicit' | 'system' | 'loopback';
  proxyUrl: string;
} | {
  source: 'direct';
};
//#endregion
//#region src/store.d.ts
declare function piLoginAuthPath(dshHome?: string): string;
declare class PiLoginCredentialStore implements CredentialStore {
  readonly filename: string;
  readonly legacyFilename: string | undefined;
  constructor(filename?: string);
  private readDocument;
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}
//#endregion
//#region src/session.d.ts
declare class PiLoginSession {
  readonly store: PiLoginCredentialStore;
  readonly models: MutableModels;
  private transportPromise?;
  constructor(store?: PiLoginCredentialStore);
  ensureTransport(): Promise<OAuthProxyResolution>;
  spec(id: string): PiLoginProvider;
  provider(id: string): import("@earendil-works/pi-ai").Provider<import("@earendil-works/pi-ai").Api>;
  visibleModels(id: string): readonly import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>[];
  /**
   * Harness routes that currently hold a stored OAuth grant.
   * Model pickers should only advertise these — logging out must drop the route.
   */
  authenticatedRoutes(): Promise<string[]>;
  logout(id: string): Promise<void>;
}
//#endregion
//#region src/adapter.d.ts
interface PiLoginAdapterOptions {
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
}
declare function createPiLoginAdapter(session: PiLoginSession, resolveAttachments: () => AttachmentStore | undefined, options?: PiLoginAdapterOptions): PiAiAdapter;
//#endregion
//#region src/auth.d.ts
interface PiLoginAuthStatus {
  providerId: string;
  authenticated: boolean;
  expiresAt?: Date;
}
declare function loginPiProvider(providerId: string, interaction: AuthInteraction, store?: PiLoginCredentialStore): Promise<void>;
declare function logoutPiProvider(providerId: string, store?: PiLoginCredentialStore): Promise<void>;
declare function piLoginStatus(store?: PiLoginCredentialStore, providerId?: string): Promise<PiLoginAuthStatus[]>;
declare function loginPiProviderSession(providerId: string, interaction: AuthInteraction, session: PiLoginSession): Promise<void>;
//#endregion
//#region src/auth-routes.d.ts
declare const PI_LOGIN_AUTH_STATUS_PATH = "/plugins/dsh-oauth-login/auth/status";
declare const PI_LOGIN_AUTH_LOGIN_PATH = "/plugins/dsh-oauth-login/auth/login";
declare const PI_LOGIN_AUTH_LOGOUT_PATH = "/plugins/dsh-oauth-login/auth/logout";
type PiLoginAccountState = {
  status: 'signed-out';
} | {
  status: 'signing-in';
  url?: string;
  userCode?: string;
} | {
  status: 'signed-in';
  models: string[];
  expiresAt?: string;
} | {
  status: 'error';
  message: string;
};
interface PiLoginProviderStatus {
  id: string;
  route: string;
  displayName: string;
  shortName: string;
  account: PiLoginAccountState;
}
interface LoginChallenge {
  provider: string;
  url: string;
  userCode?: string;
}
interface PiLoginAuthRouteOptions {
  /** Called after a successful sign-in or sign-out so the host can refresh LLM routes. */
  onAuthChanged?: () => void | Promise<void>;
}
declare function registerPiLoginAuthRoutes(ctx: Context, session: PiLoginSession, options?: PiLoginAuthRouteOptions): void;
//#endregion
//#region src/extra-models.d.ts
/**
 * Extra models this plugin publishes for one pi-ai provider id.
 * @param providerId - catalog provider id (e.g. `xai`), not the harness route.
 */
declare function extraModelsFor(providerId: string): readonly Model<Api>[];
//#endregion
//#region src/ids.d.ts
/** Basename of the DSH-owned multi-provider OAuth document. */
declare const PI_LOGIN_AUTH_FILENAME = ".dsh-oauth-auth.json";
/** Legacy DSH filename accepted during the one-time storage migration. */
declare const LEGACY_PI_LOGIN_AUTH_FILENAME = ".pi-login-auth.json";
/** Prefix for harness routes so they never collide with catalog / other plugins. */
declare const PI_LOGIN_ROUTE_PREFIX = "pi-";
/** Provider idle ceiling used by every composite route. */
declare const PI_LOGIN_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Startup line `dshx verify` looks for. */
declare const PI_LOGIN_BOOT_MARKER = "[my-plugins/dsh-oauth-login] loaded";
//#endregion
//#region src/model-error-hint.d.ts
/**
 * Default Harness `retryPolicy` codes. Keep aligned with
 * `resolveRetryPolicy(undefined)` in `@deepseek-ai/dsh-llm`.
 */
declare const TRANSIENT_MODEL_CODES: readonly string[];
declare const QUOTA_HINT = "This is account quota or credits, not a temporary busy signal. Automatic retry will not refill it. Check the plan, usage window, or balance.";
declare const RATE_LIMIT_HINT = "This is a request-rate or peak-busy limit. A 429 is often this, not an empty balance. After automatic retries end, wait and send another message. If Continue fails or the composer stays stuck, start a new chat.";
declare const TRANSIENT_HINT = "After this turn ends, send another message to try again. If Continue fails or the composer stays stuck, start a new chat.";
/** Stable Chat copy for one official `LlmError` code. Does not invent 5h vs weekly vs billing. */
declare function hintForCode(code: string): string | undefined;
declare function hintFailure(failure: LlmFailure): LlmFailure;
/** Append a code-specific hint without changing the routable `code`. */
declare function withModelErrorHint(error: unknown): unknown;
//#endregion
//#region src/provider.d.ts
declare function catalogProvider(id: string): Provider;
/**
 * Catalog models plus plugin-owned extras, remapped onto the harness route.
 * Extras fill gaps the installed pi-ai version has not shipped yet (e.g. grok-4.6).
 */
declare function harnessModels(spec: PiLoginProvider): Model<Api>[];
declare function preferredModel(spec: PiLoginProvider, models?: readonly {
  id: string;
}[]): string;
declare function harnessProvider(spec: PiLoginProvider): Provider;
//#endregion
//#region src/redact.d.ts
/** Remove token-like strings from an external OAuth diagnostic. */
declare function safeMessage(error: unknown): string;
/** Only this provider's official HTTPS hosts may be opened for login. */
declare function isSafeAuthUrl(raw: string, provider: PiLoginProvider): boolean;
//#endregion
//#region src/index.d.ts
declare const name = "llm-oauth-login";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, type Config as PluginConfig, LEGACY_PI_LOGIN_AUTH_FILENAME, type LoginChallenge, PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_LOGIN_PATH, PI_LOGIN_AUTH_LOGOUT_PATH, PI_LOGIN_AUTH_STATUS_PATH, PI_LOGIN_BOOT_MARKER, PI_LOGIN_PROVIDERS, PI_LOGIN_ROUTE_PREFIX, PI_LOGIN_STREAM_IDLE_TIMEOUT_MS, type PiLoginAdapterOptions, type PiLoginAuthStatus, PiLoginCredentialStore, type PiLoginProvider, type PiLoginProviderStatus, PiLoginSession, QUOTA_HINT, RATE_LIMIT_HINT, TRANSIENT_HINT, TRANSIENT_MODEL_CODES, apply, catalogProvider, createPiLoginAdapter, extraModelsFor, harnessModels, harnessProvider, hintFailure, hintForCode, inject, isSafeAuthUrl, loginPiProvider, loginPiProviderSession, logoutPiProvider, name, piLoginAuthPath, piLoginProvider, piLoginRoutes, piLoginStatus, preferredModel, registerPiLoginAuthRoutes, safeMessage, withModelErrorHint };