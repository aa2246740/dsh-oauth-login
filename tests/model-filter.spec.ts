import { describe, expect, it } from 'vitest'
import { filterGroups } from '../src/client/model-filter.ts'
import type { FilterGroup } from '../src/client/model-filter.ts'

const groups: FilterGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'pi-openai-codex',
    name: 'ChatGPT Codex',
    models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: 'reasoning' }],
  },
]

describe('filterGroups', () => {
  it('keeps identity for blank queries', () => {
    expect(filterGroups(groups, '')).toBe(groups)
    expect(filterGroups(groups, '   ')).toBe(groups)
  })

  it('matches model name case-insensitively', () => {
    const out = filterGroups(groups, 'LUNA')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('pi-openai-codex')
    expect(out[0].models.map(m => m.id)).toEqual(['gpt-5.6-luna'])
  })

  it('matches model id and provider name', () => {
    expect(filterGroups(groups, 'v4-pro')[0].models).toHaveLength(1)
    expect(filterGroups(groups, 'deepseek')[0].models).toHaveLength(2)
  })

  it('drops groups with no surviving models and preserves order', () => {
    const out = filterGroups(groups, 'flash')
    expect(out.map(g => g.id)).toEqual(['deepseek-official'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterGroups(groups, 'claude')).toEqual([])
  })

  it('filters only officially free OpenRouter IDs, never subscription models with zero costs', () => {
    const catalog = [...groups, {
      id: 'pi-openrouter', name: 'OpenRouter',
      models: [
        { id: 'minimax/minimax-m3', name: 'MiniMax M3' },
        { id: 'minimax/minimax-m3:free', name: 'MiniMax M3 (free)' },
        { id: 'vendor/promo', name: 'Promotion without suffix' },
      ],
    }]
    const free = new Set(['minimax/minimax-m3:free', 'vendor/promo', 'gpt-5.6-luna'])
    expect(filterGroups(catalog, '', free).map(group => group.id)).toEqual(['pi-openrouter'])
    expect(filterGroups(catalog, '', free)[0].models.map(model => model.id)).toEqual(['minimax/minimax-m3:free', 'vendor/promo'])
    expect(filterGroups(catalog, 'MINIMAX', free)[0].models.map(model => model.id)).toEqual(['minimax/minimax-m3:free'])
    expect(filterGroups(catalog, '', new Set())).toEqual([])
  })
})
