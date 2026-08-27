export type Drafts = Record<string, string>
export type DraftUpdater = (current: Drafts) => Drafts
export type DraftSetter = (updater: DraftUpdater) => void

export function applyDraftChange(
  providerId: string,
  event: { currentTarget: { value: string } },
  setDrafts: DraftSetter,
): void {
  const value = event.currentTarget.value
  setDrafts(current => ({ ...current, [providerId]: value }))
}
