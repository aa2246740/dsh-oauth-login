export interface LoginPopup {
  close(): void
  location: { replace(url: string): void }
}

export type LoginUrlOpener = (url: string) => void

/** Deliver a login challenge even when an Electron shell rejects the reserved about:blank popup. */
export function openLoginChallenge(
  popup: LoginPopup | null,
  url: string | undefined,
  openUrl: LoginUrlOpener,
): 'reserved' | 'fallback' | 'none' {
  if (url === undefined) {
    popup?.close()
    return 'none'
  }
  if (popup !== null) {
    popup.location.replace(url)
    return 'reserved'
  }
  openUrl(url)
  return 'fallback'
}
