/**
 * When to spend a refresh_token. Chat already refreshes via Models.getAuth;
 * this helper is for status / boot / the host timer so the store does not sit
 * on a stale expires stamp.
 */

/** Refresh when the stored access stamp is inside this window (Pi already skews expires by 5 min). */
export const OAUTH_REFRESH_SOON_MS = 15 * 60 * 1000

/** Host timer. Access lives ~6h; this is just how often we look. */
export const OAUTH_REFRESH_POLL_MS = 15 * 60 * 1000

/** After a failed refresh, do not hit the token endpoint again until this elapses. */
export const OAUTH_REFRESH_COOLDOWN_MS = 5 * 60 * 1000

const lastAttempt = new Map<string, number>()

export function grantNeedsRefresh(expires: number, now = Date.now()): boolean {
  return now >= expires - OAUTH_REFRESH_SOON_MS
}

export function refreshAttemptKey(storeId: string, providerId: string): string {
  return `${storeId}\0${providerId}`
}

export function refreshOnCooldown(key: string, now = Date.now()): boolean {
  const previous = lastAttempt.get(key)
  return previous !== undefined && now - previous < OAUTH_REFRESH_COOLDOWN_MS
}

export function markRefreshAttempt(key: string, now = Date.now()): void {
  lastAttempt.set(key, now)
}

export function clearRefreshAttempts(): void {
  lastAttempt.clear()
}

export async function refreshGrant(
  getAuth: (providerId: string) => Promise<unknown>,
  providerId: string,
): Promise<'ok' | 'failed'> {
  try {
    await getAuth(providerId)
    return 'ok'
  } catch {
    return 'failed'
  }
}
