import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { AuthInteraction, Credential, CredentialInfo, CredentialStore, MutableModels, Provider } from "@earendil-works/pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
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
  logout(id: string): Promise<void>;
}
//#endregion
//#region src/adapter.d.ts
declare function createPiLoginAdapter(session: PiLoginSession, resolveAttachments: () => AttachmentStore | undefined): PiAiAdapter;
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
declare const PI_LOGIN_AUTH_STATUS_PATH = "/plugins/dsh-pi-login/auth/status";
declare const PI_LOGIN_AUTH_LOGIN_PATH = "/plugins/dsh-pi-login/auth/login";
declare const PI_LOGIN_AUTH_LOGOUT_PATH = "/plugins/dsh-pi-login/auth/logout";
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
declare function registerPiLoginAuthRoutes(ctx: Context, session: PiLoginSession): void;
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
//#endregion
//#region src/provider.d.ts
declare function catalogProvider(id: string): Provider;
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
declare const name = "llm-pi-login";
declare const inject: string[];
interface Config {}
declare const Config: z<Config>;
declare function apply(ctx: Context, _config: Config): void;
//#endregion
export { Config, LEGACY_PI_LOGIN_AUTH_FILENAME, type LoginChallenge, PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_LOGIN_PATH, PI_LOGIN_AUTH_LOGOUT_PATH, PI_LOGIN_AUTH_STATUS_PATH, PI_LOGIN_PROVIDERS, PI_LOGIN_ROUTE_PREFIX, PI_LOGIN_STREAM_IDLE_TIMEOUT_MS, type PiLoginAuthStatus, PiLoginCredentialStore, type PiLoginProvider, type PiLoginProviderStatus, PiLoginSession, apply, catalogProvider, createPiLoginAdapter, harnessProvider, inject, isSafeAuthUrl, loginPiProvider, loginPiProviderSession, logoutPiProvider, name, piLoginAuthPath, piLoginProvider, piLoginRoutes, piLoginStatus, preferredModel, registerPiLoginAuthRoutes, safeMessage };