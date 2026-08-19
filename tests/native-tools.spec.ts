import { describe, expect, it } from 'vitest'
import {
  applyNativeToolsToPayload,
  DEFAULT_NATIVE_TOOL_POLICY,
  filterHostedServerToolTraces,
  filterXaiServerToolTraces,
  isHostedSearchReasoningReplay,
  filterPiContext,
  isDshWebFunctionTool,
  isHostedServerToolCall,
  isXaiServerXSearchCall,
  maskDshWebAssembly,
  nativePlan,
  nativePlanForRoute,
  wrapOnPayload,
} from '../src/native-tools.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

async function* stream(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks
}

describe('native OAuth tools', () => {
  it('recognizes only documented xAI server X Search calls with xs_call ids', () => {
    expect(isXaiServerXSearchCall({
      type: 'tool-call',
      id: 'xs_call-123|ctc_456',
      name: 'x_keyword_search',
      arguments: '{}',
    })).toBe(true)
    expect(isXaiServerXSearchCall({
      type: 'tool-call',
      id: 'call_123|fc_456',
      name: 'x_keyword_search',
      arguments: '{}',
    })).toBe(false)
  })

  it('drops server X Search traces and completes the hosted answer without a Harness tool step', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'cited answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'cited answer' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'tool-call-delta', index: 1, id: 'xs_call-1|ctc_1' as never,
        name: 'x_semantic_search', argumentsDelta: '{}',
      },
      {
        type: 'block-end', index: 1,
        block: {
          type: 'tool-call', id: 'xs_call-1|ctc_1' as never,
          name: 'x_semantic_search', arguments: '{}',
        },
      },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: {
          kind: 'pi-ai', version: 1, api: 'openai-responses', provider: 'pi-xai', model: 'grok-4.6',
          stopReason: 'toolUse', blocks: [{ type: 'text' }, { type: 'tool-call' }],
        },
      },
    ]
    const result = await collect(filterXaiServerToolTraces(stream(chunks)))
    expect(result.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(result.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    const finish = result.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({
      type: 'finish', reason: { kind: 'stop' },
      replayState: { stopReason: 'stop', blocks: [{ type: 'text' }] },
    })
  })

  it('preserves a real client-side tool call and the tool-calls finish', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: 'call_1|fc_1' as never,
          name: 'x_keyword_search', arguments: '{}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    expect(await collect(filterXaiServerToolTraces(stream(chunks)))).toEqual(chunks)
  })

  it('drops leftover hosted web_search calls so Harness does not report unknown tool', async () => {
    expect(isHostedServerToolCall({
      type: 'tool-call',
      id: 'ws_1|fc_1',
      name: 'web_search',
      arguments: '{}',
    })).toBe(true)
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'cited' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'cited' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'block-end', index: 1,
        block: {
          type: 'tool-call', id: 'call_ws|fc_1' as never,
          name: 'web_search', arguments: '{"query":"news"}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const result = await collect(filterHostedServerToolTraces(stream(chunks)))
    expect(result.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(result.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('drops empty hosted-search Think cards and keeps real reasoning plus interleaved text', async () => {
    const tco = JSON.stringify({
      id: 'tco_0dd37026_call-84add039-0',
      type: 'reasoning',
      status: 'completed',
      summary: [],
    })
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '\n\nThe user wants news.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '\n\nThe user wants news.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '正在检索' },
      { type: 'block-start', index: 3, blockType: 'reasoning' },
      { type: 'block-end', index: 3, block: { type: 'reasoning', text: '' } },
      { type: 'block-start', index: 4, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 4, text: '  \n' },
      { type: 'block-end', index: 4, block: { type: 'reasoning', text: '  \n' } },
      { type: 'text-delta', index: 1, text: '。' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '正在检索。' } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          kind: 'pi-ai', version: 1, api: 'openai-responses', provider: 'pi-xai', model: 'grok-4.6',
          stopReason: 'stop',
          blocks: [
            { type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'rs_real', type: 'reasoning' }) },
            { type: 'text' },
            { type: 'reasoning', thinkingSignature: tco },
          ],
        },
      },
    ]
    const result = await collect(filterHostedServerToolTraces(stream(chunks)))
    const reasoningEnds = result.filter(chunk => (
      chunk.type === 'block-end' && chunk.block.type === 'reasoning'
    ))
    expect(reasoningEnds).toHaveLength(1)
    expect(reasoningEnds[0]).toMatchObject({
      block: { type: 'reasoning', text: '\n\nThe user wants news.' },
    })
    expect(result.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual([
      '正在检索',
      '。',
    ])
    const finish = result.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({
      replayState: {
        blocks: [
          { type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'rs_real', type: 'reasoning' }) },
          { type: 'text' },
        ],
      },
    })
    expect(isHostedSearchReasoningReplay({ type: 'reasoning', thinkingSignature: tco })).toBe(true)
    expect(isHostedSearchReasoningReplay({
      type: 'reasoning',
      thinkingSignature: JSON.stringify({ id: 'rs_real', type: 'reasoning' }),
    })).toBe(false)
  })

  it('drops Think that starts after the visible reply, so it cannot sit under the answer', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user wants me to search X and The Verge.' },
      {
        type: 'block-end', index: 0,
        block: { type: 'reasoning', text: 'The user wants me to search X and The Verge.' },
      },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '我先同时查 X 和 The Verge。' },
      { type: 'block-start', index: 7, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 7, text: 'I have good results. Let me compile a clear summary of the latest T...' },
      {
        type: 'block-end', index: 7,
        block: { type: 'reasoning', text: 'I have good results. Let me compile a clear summary of the latest T...' },
      },
      { type: 'block-end', index: 1, block: { type: 'text', text: '我先同时查 X 和 The Verge。' } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          kind: 'pi-ai', version: 1, api: 'openai-responses', provider: 'pi-xai', model: 'grok-4.6',
          stopReason: 'stop',
          blocks: [
            { type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'rs_open', type: 'reasoning' }) },
            { type: 'text' },
            { type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'rs_late', type: 'reasoning' }) },
          ],
        },
      },
    ]
    const result = await collect(filterHostedServerToolTraces(stream(chunks)))
    const reasoning = result.filter(chunk => (
      chunk.type === 'block-end' && chunk.block.type === 'reasoning'
    ))
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({
      block: { text: 'The user wants me to search X and The Verge.' },
    })
    expect(result.find(chunk => chunk.type === 'finish')).toMatchObject({
      replayState: {
        blocks: [
          { type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'rs_open', type: 'reasoning' }) },
          { type: 'text' },
        ],
      },
    })
  })

  it('gives Grok hosted search, X search, and image generation', () => {
    const plan = nativePlan('xai')
    expect(plan?.hosted).toEqual([
      { type: 'web_search' },
      { type: 'x_search' },
      { type: 'image_generation' },
    ])
  })

  it('gives Codex hosted search and image generation', () => {
    expect(nativePlan('openai-codex')?.hosted).toEqual([
      { type: 'web_search' },
      { type: 'image_generation' },
    ])
  })

  it('gives Claude the Anthropic server search tool only', () => {
    expect(nativePlan('anthropic')?.hosted).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
    ])
  })

  it('does not invent hosted tools for Copilot, OpenRouter, or Kimi', () => {
    expect(nativePlan('github-copilot')).toBeUndefined()
    expect(nativePlan('openrouter')).toBeUndefined()
    expect(nativePlan('kimi-coding')).toBeUndefined()
  })

  it('maps harness routes back to the same plan', () => {
    expect(nativePlanForRoute('pi-xai')?.providerId).toBe('xai')
    expect(nativePlanForRoute('pi-openai-codex')?.providerId).toBe('openai-codex')
    expect(nativePlanForRoute('deepseek-official')).toBeUndefined()
  })

  it('can disable image generation without dropping search', () => {
    expect(nativePlan('xai', { enabled: true, image: false })?.hosted).toEqual([
      { type: 'web_search' },
      { type: 'x_search' },
    ])
  })

  it('can turn the whole overlay off', () => {
    expect(nativePlan('xai', { enabled: false, image: true })).toBeUndefined()
  })

  it('strips DSH function web tools and prepends hosted tools', () => {
    const next = applyNativeToolsToPayload({
      model: 'grok-4.6',
      tools: [
        { type: 'function', name: 'bash', parameters: {} },
        { type: 'function', name: 'web_search', parameters: { query: { type: 'string' } } },
        { type: 'function', name: 'web_fetch', parameters: { url: { type: 'string' } } },
      ],
    }, 'xai')
    expect(next).toEqual({
      model: 'grok-4.6',
      tools: [
        { type: 'web_search' },
        { type: 'x_search' },
        { type: 'image_generation' },
        { type: 'function', name: 'bash', parameters: {} },
      ],
    })
  })

  it('does not duplicate hosted tools already on the payload', () => {
    const next = applyNativeToolsToPayload({
      tools: [{ type: 'web_search' }, { type: 'function', name: 'read' }],
    }, 'openai-codex') as { tools: Record<string, unknown>[] }
    expect(next.tools.filter(tool => tool.type === 'web_search')).toHaveLength(1)
    expect(next.tools.some(tool => tool.type === 'image_generation')).toBe(true)
  })

  it('leaves non-object payloads alone', () => {
    expect(applyNativeToolsToPayload('raw', 'xai')).toBe('raw')
  })

  it('does not treat a hosted web_search as a DSH function tool', () => {
    expect(isDshWebFunctionTool({ type: 'web_search' })).toBe(false)
    expect(isDshWebFunctionTool({ type: 'function', name: 'web_search' })).toBe(true)
    expect(isDshWebFunctionTool({ name: 'web_search' })).toBe(true)
  })

  it('filters DSH web tools out of the pi-ai context', () => {
    const filtered = filterPiContext({
      messages: [],
      tools: [
        { name: 'bash', description: '', parameters: {} },
        { name: 'web_search', description: '', parameters: {} },
      ],
    }, 'xai')
    expect(filtered.tools?.map(tool => tool.name)).toEqual(['bash'])
  })

  it('rewrites the prompt assembly for an OAuth native route', () => {
    const plan = nativePlan('xai')
    if (plan === undefined) throw new Error('xai plan missing')
    const next = maskDshWebAssembly({
      tools: [{ name: 'bash' }, { name: 'web_search' }, { name: 'web_fetch' }],
      sections: [
        { name: 'deployment:persona', text: 'You are helpful.' },
        { name: 'tool:web_search', text: 'Use the web_search tool.' },
      ],
    }, plan)
    expect(next.tools.map(tool => tool.name)).toEqual(['bash'])
    expect(next.sections.map(section => section.name)).toEqual([
      'deployment:persona',
      'oauth:native-tools',
    ])
    expect(next.sections[1]?.text).toContain('native hosted search')
  })

  it('chains an existing onPayload after injection', async () => {
    const seen: unknown[] = []
    const onPayload = wrapOnPayload((payload) => {
      seen.push(payload)
      return { wrapped: true, payload }
    }, 'anthropic', DEFAULT_NATIVE_TOOL_POLICY)
    if (onPayload === undefined) throw new Error('onPayload missing')
    const result = await onPayload({ tools: [{ type: 'function', name: 'web_search' }] }, {
      id: 'claude-opus-4-6',
    } as never)
    expect(seen[0]).toEqual({
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })
    expect(result).toEqual({
      wrapped: true,
      payload: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    })
  })
})
