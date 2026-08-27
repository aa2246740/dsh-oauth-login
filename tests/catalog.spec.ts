import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { PI_LOGIN_PROVIDERS, piLoginProvider, piLoginRoutes } from '../src/catalog.ts'
import { defaultReasoningEffortFor, extraModelsFor } from '../src/extra-models.ts'
import { catalogProvider, harnessModels, harnessProvider, preferredModel } from '../src/provider.ts'

describe('Pi login catalog', () => {
  it('covers the Pi subscription credential set', () => {
    expect(PI_LOGIN_PROVIDERS.map(provider => provider.id).sort()).toEqual([
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'openai-codex',
      'openrouter',
      'xai',
      'zai-coding-cn',
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

  it('publishes stealth/ox-alpha on the OpenRouter harness route even when pi-ai lags', () => {
    const openrouter = piLoginProvider('openrouter')
    if (openrouter === undefined) throw new Error('openrouter missing')
    const ids = harnessModels(openrouter).map(model => model.id)
    expect(ids).toContain('stealth/ox-alpha')
    expect(extraModelsFor('openrouter').some(model => model.id === 'stealth/ox-alpha')).toBe(true)
    expect(ids).toContain('z-ai/glm-5.2')
    const ox = harnessModels(openrouter).find(model => model.id === 'stealth/ox-alpha')
    if (ox === undefined) throw new Error('stealth/ox-alpha missing')
    expect(ox.provider).toBe('pi-openrouter')
    expect(ox.contextWindow).toBe(1_000_000)
    expect(ox.input).toEqual(['text', 'image'])
  })

  it('maps the China GLM Coding Plan onto its dedicated key-backed route', () => {
    const zhipu = piLoginProvider('zai-coding-cn')
    if (zhipu === undefined) throw new Error('zai-coding-cn missing')
    expect(zhipu.authType).toBe('api_key')
    expect(zhipu.loginUrl).toBe('https://bigmodel.cn/coding-plan/personal/overview')
    expect(zhipu.route).toBe('pi-zai-coding-cn')
    expect(catalogProvider(zhipu.id).auth.apiKey?.login).toBeTypeOf('function')
    const ids = harnessModels(zhipu).map(model => model.id)
    expect(ids).toContain('glm-5.3-flash')
    expect(ids).toContain('glm-5.2')
    expect(preferredModel(zhipu)).toBe('glm-5.3-flash')
  })

  it('publishes GLM-5.3-Flash with its official multimodal and reasoning contract', () => {
    const zhipu = piLoginProvider('zai-coding-cn')
    if (zhipu === undefined) throw new Error('zai-coding-cn missing')
    const flash = harnessModels(zhipu).find(model => model.id === 'glm-5.3-flash')
    if (flash === undefined) throw new Error('glm-5.3-flash missing')
    expect(flash.provider).toBe('pi-zai-coding-cn')
    expect(flash.contextWindow).toBe(1_000_000)
    expect(flash.maxTokens).toBe(131_072)
    expect(flash.input).toEqual(['text', 'image'])
    expect(getSupportedThinkingLevels(flash)).toEqual(['low', 'high', 'max'])
    expect(defaultReasoningEffortFor(flash.id)).toBe('max')
    expect(extraModelsFor('zai-coding-cn').some(model => model.id === flash.id)).toBe(true)
  })

  it('offers only OpenRouter live efforts on stealth/ox-alpha, defaulting to max', () => {
    const openrouter = piLoginProvider('openrouter')
    if (openrouter === undefined) throw new Error('openrouter missing')
    const ox = harnessModels(openrouter).find(model => model.id === 'stealth/ox-alpha')
    if (ox === undefined) throw new Error('stealth/ox-alpha missing')
    expect(getSupportedThinkingLevels(ox)).toEqual(['low', 'high', 'max'])
    expect(defaultReasoningEffortFor(ox.id)).toBe('max')
    expect(defaultReasoningEffortFor('z-ai/glm-5.2')).toBeUndefined()
  })
})
