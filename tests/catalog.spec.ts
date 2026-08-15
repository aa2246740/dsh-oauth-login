import { describe, expect, it } from 'vitest'
import { PI_LOGIN_PROVIDERS, piLoginRoutes } from '../src/catalog.ts'
import { catalogProvider, harnessProvider, preferredModel } from '../src/provider.ts'

describe('Pi login catalog', () => {
  it('covers the Pi subscription OAuth set', () => {
    expect(PI_LOGIN_PROVIDERS.map(provider => provider.id).sort()).toEqual([
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'openai-codex',
      'openrouter',
      'xai',
    ])
  })

  it('uses pi- prefixed harness routes', () => {
    expect(piLoginRoutes().every(route => route.startsWith('pi-'))).toBe(true)
  })

  it('maps every provider onto a live pi-ai catalog entry', () => {
    for (const spec of PI_LOGIN_PROVIDERS) {
      const catalog = catalogProvider(spec.id)
      expect(catalog.id).toBe(spec.id)
      expect(catalog.getModels().length).toBeGreaterThan(0)
      const harness = harnessProvider(spec)
      expect(harness.id).toBe(spec.route)
      expect(harness.getModels().every(model => model.provider === spec.route)).toBe(true)
      expect(catalog.getModels().some(model => model.id === preferredModel(spec))).toBe(true)
    }
  })
})
