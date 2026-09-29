import { describe, expect, it } from 'vitest'
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'
import { prepareNativeToolRequest } from '../src/native-tools.ts'

const bash = { name: 'bash', description: '', parameters: {} }
const search = { name: 'web_search', description: '', parameters: {} }

describe('RC2 transcript tool declarations', () => {
  it('filters web tool deltas while preserving system instructions and ordinary tools', () => {
    const context = normalizeContext({ messages: [
      { role: 'system', content: 'Keep this instruction.', sections: { policy: 'Keep this section.' }, toolsAdded: [bash, search], timestamp: 1 },
      { role: 'system', content: 'Later instruction.', toolsRemoved: [{ name: 'web_search' }], toolsAdded: [{ ...search, name: 'web_fetch' }], timestamp: 2 },
    ] })
    const prepared = prepareNativeToolRequest(context, {}, 'xai', 'openai-responses')
    expect(getCurrentTools(prepared.context.messages).map(tool => tool.name)).toEqual(['bash'])
    expect(prepared.context.messages[0]).toMatchObject({ content: 'Keep this instruction.', sections: { policy: 'Keep this section.' } })
    expect(prepared.options.onPayload).toBeTypeOf('function')
    expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(['bash', 'web_fetch'])
  })

  it('does not enable hosted tools after every tool has been removed', () => {
    const context = normalizeContext({ messages: [
      { role: 'system', content: '', toolsAdded: [search], timestamp: 1 },
      { role: 'system', content: 'Answer without tools.', toolsRemoved: [{ name: 'web_search' }], timestamp: 2 },
    ] })
    const prepared = prepareNativeToolRequest(context, {}, 'xai', 'openai-responses')
    expect(prepared.options.onPayload).toBeUndefined()
    expect(prepared.context).toBe(context)
  })

  it('injects hosted tools when normalized declarations contained only web tools', async () => {
    const prepared = prepareNativeToolRequest(normalizeContext({ messages: [], tools: [search] }), {}, 'xai', 'openai-responses')
    expect(getCurrentTools(prepared.context.messages)).toEqual([])
    const payload = await prepared.options.onPayload?.({ model: 'grok-4.6' }, { id: 'grok-4.6', api: 'openai-responses' } as never)
    expect(payload).toMatchObject({ tools: [{ type: 'web_search' }, { type: 'x_search' }, { type: 'image_generation' }] })
  })
})
