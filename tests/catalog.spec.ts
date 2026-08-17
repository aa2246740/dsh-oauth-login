import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { PI_LOGIN_PROVIDERS, piLoginProvider, piLoginRoutes } from '../src/catalog.ts'
import { extraModelsFor } from '../src/extra-models.ts'
import { catalogProvider, harnessModels, harnessProvider, preferredModel } from '../src/provider.ts'

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
      expect(harness.getModels().some(model => model.id === preferredModel(spec))).toBe(true)
    }
  })

  it('publishes grok-4.6 on the xAI harness route even when pi-ai lags', () => {
    const xai = piLoginProvider('xai')
    if (xai === undefined) throw new Error('xai missing')
    const ids = harnessModels(xai).map(model => model.id)
    expect(ids).toContain('grok-4.6')
    expect(preferredModel(xai)).toBe('grok-4.6')
    expect(extraModelsFor('xai').some(model => model.id === 'grok-4.6')).toBe(true)
    // Extras must not hide the installed catalog entries.
    expect(ids).toContain('grok-4.5')
    expect(ids).toContain('grok-4.3')
  })

  it('offers xhigh on grok-4.6', () => {
    const xai = piLoginProvider('xai')
    if (xai === undefined) throw new Error('xai missing')
    const grok46 = harnessModels(xai).find(model => model.id === 'grok-4.6')
    if (grok46 === undefined) throw new Error('grok-4.6 missing')
    expect(getSupportedThinkingLevels(grok46)).toContain('xhigh')
  })
})
