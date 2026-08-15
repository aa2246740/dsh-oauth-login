import type { PiLoginProvider } from './catalog.ts'

/** Remove token-like strings from an external OAuth diagnostic. */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token|key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 1000)
}

/** Only this provider's official HTTPS hosts may be opened for login. */
export function isSafeAuthUrl(raw: string, provider: PiLoginProvider): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    if (provider.allowedHosts.includes(host)) return true
    return provider.allowedSuffixes.some(suffix => host.endsWith(suffix))
  } catch {
    return false
  }
}
