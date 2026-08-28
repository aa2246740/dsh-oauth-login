import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { createPiLoginAdapter } from '../src/adapter.ts'
import { PiLoginCredentialStore } from '../src/store.ts'
import { PiLoginSession } from '../src/session.ts'

async function tempSession(): Promise<PiLoginSession> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-session-'))
  return new PiLoginSession(new PiLoginCredentialStore(join(dir, 'auth.json')), undefined, undefined, {
    env: {}, platform: 'linux', candidates: [],
  })
}

describe('authenticated harness routes', () => {
  it('starts empty and only lists routes with a stored grant', async () => {
    const session = await tempSession()
    expect(await session.authenticatedRoutes()).toEqual([])

    await session.store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires: 1_700_000_000_000,
    }))
    expect(await session.authenticatedRoutes()).toEqual(['pi-xai'])

    await session.store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'codex-access',
      refresh: 'codex-refresh',
      expires: 1_700_000_000_001,
    }))
    expect((await session.authenticatedRoutes()).sort()).toEqual(['pi-openai-codex', 'pi-xai'])

    await session.logout('xai')
    expect(await session.authenticatedRoutes()).toEqual(['pi-openai-codex'])

    await session.logout('openai-codex')
    expect(await session.authenticatedRoutes()).toEqual([])
  })

  it('still exposes grok-4.6 once xAI is signed in', async () => {
    const session = await tempSession()
    await session.store.modify('xai', async () => ({
      type: 'oauth',
      access: 'xai-access',
      refresh: 'xai-refresh',
      expires: 1_700_000_000_000,
    }))
    expect(session.visibleModels('xai').map(model => model.id)).toContain('grok-4.6')
  })

  it('still exposes stealth/ox-alpha once OpenRouter is signed in', async () => {
    const session = await tempSession()
    await session.store.modify('openrouter', async () => ({
      type: 'oauth',
      access: 'openrouter-access',
      refresh: '',
      expires: 1_700_000_000_000,
    }))
    expect(session.visibleModels('openrouter').map(model => model.id)).toContain('stealth/ox-alpha')
  })

  it('publishes the Zhipu route for a stored Plan API key', async () => {
    const session = await tempSession()
    await session.store.modify('zai-coding-cn', async () => ({
      type: 'api_key',
      key: 'test-zhipu-plan-key',
    }))
    expect(await session.authenticatedRoutes()).toEqual(['pi-zai-coding-cn'])
    expect(session.visibleModels('zai-coding-cn').map(model => model.id)).toContain('glm-5.3')
    expect(session.visibleModels('zai-coding-cn').map(model => model.id)).toContain('glm-5.3-flash')
    expect(session.visibleModels('zai-coding-cn').map(model => model.id)).toContain('glm-5.2')
  })

  it('resolves standard GLM-5.3 and Flash as distinct DSH model choices', async () => {
    const session = await tempSession()
    session.ensureTransport = async () => ({ source: 'direct' })
    await session.store.modify('zai-coding-cn', async () => ({
      type: 'api_key',
      key: 'test-zhipu-plan-key',
    }))
    const adapter = createPiLoginAdapter(session, () => undefined)
    const ids = (await adapter.listModels('pi-zai-coding-cn')).map(model => model.id)
    for (const id of ['glm-5.3', 'glm-5.3-flash']) {
      expect(ids.filter(candidate => candidate === id)).toHaveLength(1)
      expect(await adapter.resolveModel('pi-zai-coding-cn', id)).toMatchObject({
        id,
        context: { contextWindow: 1_000_000 },
        reasoning: { defaultEffort: 'max' },
      })
    }
  })
})

describe('provider recovery at the subscription adapter boundary', () => {
  const cases = [
    {
      provider: 'pi-openai-codex', model: 'gpt-5.6-sol', code: 'PI_AI_ERROR', expected: 'TRANSPORT',
      message: 'WebSocket error',
    },
    {
      provider: 'pi-openai-codex', model: 'gpt-5.6-sol', code: 'PI_AI_ERROR', expected: 'SERVER',
      message: 'Codex error: Our servers are currently overloaded. Please try again later.',
    },
    {
      provider: 'pi-zai-coding-cn', model: 'glm-5.3-flash', code: 'RATE_LIMIT', expected: 'QUOTA',
      message: '429: {"code":"1310","message":"您已达到每周/每月使用上限"}',
    },
  ].flatMap(testCase => ['finish', 'throw'].flatMap(delivery => ['direct', 'prepared'].map(entry => ({ ...testCase, delivery, entry }))))

  it.each(cases)('normalizes $provider errors delivered by $delivery through $entry calls', async ({ provider, model, code, expected, message, delivery, entry }) => {
    const session = await tempSession()
    const adapter = createPiLoginAdapter(session, () => undefined)
    const injectedStream = async function* (): AsyncIterable<StreamChunk> {
      if (delivery === 'throw') throw new LlmError(message, code)
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
    }
    const upstream = vi.spyOn(PiAiAdapter.prototype, 'stream').mockImplementation(injectedStream)
    const basePrepare = PiAiAdapter.prototype.prepareCall
    const preparedUpstream = vi.spyOn(PiAiAdapter.prototype, 'prepareCall').mockImplementation(async function (this: PiAiAdapter, ...args) {
      const prepared = await basePrepare.apply(this, args)
      return { ...prepared, stream: injectedStream }
    })
    const collect = async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      const options = { provider, model, messages: [] }
      const stream = entry === 'prepared'
        ? (await adapter.prepareCall(provider, model)).stream(options)
        : adapter.stream(options)
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    }
    try {
      if (delivery === 'throw') {
        await expect(collect()).rejects.toMatchObject({ code: expected })
      } else {
        expect(await collect()).toMatchObject([
          { type: 'finish', reason: { kind: 'error', failure: { code: expected } } },
        ])
      }
    } finally {
      upstream.mockRestore()
      preparedUpstream.mockRestore()
    }
  })
})
