/**
 * Pure filtering for the searchable composer model seat. Kept free of React
 * so the unit suite can exercise it without a DOM.
 */

/** Minimal structural mirror of the host model catalog row (no runtime import). */
export interface FilterModel {
  id: string
  name: string
  description?: string
}

/** Minimal structural mirror of one provider group. */
export interface FilterGroup {
  id: string
  name: string
  models: readonly FilterModel[]
}

/**
 * Case-insensitive substring filter over model name, model id, and provider
 * name. Blank queries return the input unchanged (same array identity).
 * Groups whose every model is filtered out disappear; relative order holds.
 * @param groups - provider groups from the shared directory snapshot.
 * @param query - raw user text; trimmed and lowercased here.
 * @returns the filtered groups.
 */
export function filterGroups(
  groups: readonly FilterGroup[],
  query: string,
  freeModels?: ReadonlySet<string>,
): readonly FilterGroup[] {
  const q = query.trim().toLowerCase()
  if (q === '' && freeModels === undefined) return groups
  const out: FilterGroup[] = []
  for (const group of groups) {
    if (freeModels !== undefined && group.id !== 'pi-openrouter') continue
    const groupHit = group.name.toLowerCase().includes(q)
    const matches = groupHit ? group.models : group.models.filter(model =>
      model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q))
    const models = freeModels === undefined ? matches : matches.filter(model => freeModels.has(model.id))
    if (models.length > 0) out.push({ ...group, models })
  }
  return out
}
