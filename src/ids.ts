/** Basename of the DSH-owned multi-provider OAuth document. */
export const PI_LOGIN_AUTH_FILENAME = '.dsh-oauth-auth.json'

/** Legacy DSH filename accepted during the one-time storage migration. */
export const LEGACY_PI_LOGIN_AUTH_FILENAME = '.pi-login-auth.json'

/** Prefix for harness routes so they never collide with catalog / other plugins. */
export const PI_LOGIN_ROUTE_PREFIX = 'pi-'

/** Provider idle ceiling used by every composite route. */
export const PI_LOGIN_STREAM_IDLE_TIMEOUT_MS = 300_000

/** RC8 request-level image payload ceiling; matches the official pi-ai default. */
export const PI_LOGIN_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Startup line `dshx verify` looks for. */
export const PI_LOGIN_BOOT_MARKER = '[my-plugins/dsh-oauth-login] loaded'
