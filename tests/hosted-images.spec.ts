import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  collectHostedImagesFromEvent,
  decodeHostedImage,
  injectHostedImages,
  sniffImageMediaType,
  stripAssistantImages,
} from '../src/hosted-images.ts'
import { consumeResponsesSseText, isResponsesRequest } from '../src/responses-tap.ts'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

async function* stream(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks
}

describe('hosted image receive', () => {
  it('sniffs jpeg and png magic', () => {
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    const png = decodeHostedImage(PNG_B64)
    expect(png?.mediaType).toBe('image/png')
    expect(png?.data.byteLength).toBeGreaterThan(8)
  })

  it('collects image_generation_call results from Responses events', () => {
    const images: { id?: string, base64: string }[] = []
    collectHostedImagesFromEvent({
      type: 'response.output_item.done',
      item: {
        type: 'image_generation_call',
        id: 'ig_1',
        status: 'completed',
        result: PNG_B64,
      },
    }, images)
    collectHostedImagesFromEvent({
      type: 'response.completed',
      response: {
        output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64 }],
      },
    }, images)
    expect(images).toEqual([{ id: 'ig_1', base64: PNG_B64 }])
  })

  it('parses SSE blocks and recognizes Responses URLs', () => {
    const events: unknown[] = []
    const rest = consumeResponsesSseText(
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"ig_2","status":"completed","result":"${PNG_B64}"}}\n\ndata: [DONE]\n\n`,
      event => events.push(event),
    )
    expect(rest).toBe('')
    expect(events).toHaveLength(1)
    expect(isResponsesRequest('https://api.x.ai/v1/responses', { method: 'POST' })).toBe(true)
    expect(isResponsesRequest('https://api.x.ai/v1/chat/completions', { method: 'POST' })).toBe(false)
  })

  it('strips assistant ImageBlocks so pi-ai replay still matches', () => {
    const attachment = {
      attachmentId: 'att_1',
      mediaType: 'image/png',
      bytes: 8,
      width: 1,
      height: 1,
    } as ImageAttachmentRef
    const messages = stripAssistantImages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as Message,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', attachment },
        ],
        source: { kind: 'model', provider: 'pi-xai', model: 'grok-4.6' },
      } as Message,
    ])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('injects saved ImageBlocks before usage and finish', async () => {
    const saved: SaveCall[] = []
    const result = await collect(injectHostedImages(
      stream([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'here' } },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      { images: [{ id: 'ig_1', base64: PNG_B64 }] },
      async input => {
        saved.push(input)
        return {
          attachmentId: 'att_gen' as ImageAttachmentRef['attachmentId'],
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }
      },
    ))
    expect(saved).toHaveLength(1)
    expect(result.map(chunk => chunk.type)).toEqual([
      'block-start', 'block-end', 'block-start', 'block-end', 'usage', 'finish',
    ])
    expect(result[2]).toMatchObject({ type: 'block-start', index: 1, blockType: 'image' })
    expect(result[3]).toMatchObject({
      type: 'block-end',
      block: { type: 'image', attachment: { attachmentId: 'att_gen', mediaType: 'image/png' } },
    })
  })
})

type SaveCall = { data: Uint8Array, mediaType: string, name?: string }
