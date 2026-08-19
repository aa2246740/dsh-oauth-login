/**
 * Receive hosted image_generation_call results as durable DSH ImageBlocks.
 * pi-ai 0.82.1 drops those items; the UI already renders assistant images.
 */

import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HostedCapture, HostedImage } from './hosted-capture.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

function stripDataUrl(value: string): string {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(value.trim())
  return match?.[1] ?? value.trim()
}

function base64FromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return stripDataUrl(value)
  if (!isRecord(value)) return undefined
  if (typeof value.b64_json === 'string' && value.b64_json.length > 0) return stripDataUrl(value.b64_json)
  if (typeof value.base64 === 'string' && value.base64.length > 0) return stripDataUrl(value.base64)
  if (typeof value.result === 'string' && value.result.length > 0) return stripDataUrl(value.result)
  return undefined
}

function pushImage(into: HostedImage[], id: string | undefined, base64: string): void {
  if (id !== undefined && into.some(existing => existing.id === id)) return
  if (id === undefined && into.some(existing => existing.base64 === base64)) return
  into.push(id === undefined ? { base64 } : { id, base64 })
}

export function collectHostedImageFromItem(item: unknown, into: HostedImage[]): void {
  if (!isRecord(item) || item.type !== 'image_generation_call') return
  if (item.status !== undefined && item.status !== 'completed') return
  const base64 = base64FromUnknown(item.result)
  if (base64 === undefined) return
  pushImage(into, typeof item.id === 'string' ? item.id : undefined, base64)
}

export function collectHostedImagesFromEvent(event: unknown, into: HostedImage[]): void {
  if (!isRecord(event) || typeof event.type !== 'string') return

  if (event.type === 'response.output_item.done') {
    collectHostedImageFromItem(event.item, into)
    return
  }

  if (event.type.startsWith('response.image_generation_call.')) {
    collectHostedImageFromItem(event.item, into)
    if (event.type.endsWith('.completed')) {
      const base64 = base64FromUnknown(event.result)
      if (base64 !== undefined) {
        const id = typeof event.item_id === 'string'
          ? event.item_id
          : isRecord(event.item) && typeof event.item.id === 'string' ? event.item.id : undefined
        pushImage(into, id, base64)
      }
    }
    return
  }

  if (event.type !== 'response.completed' && event.type !== 'response.incomplete') return
  const output = isRecord(event.response) ? event.response.output : undefined
  if (!Array.isArray(output)) return
  for (const item of output) collectHostedImageFromItem(item, into)
}

export function decodeHostedImage(base64: string): { data: Uint8Array, mediaType: ImageMediaType } | undefined {
  let data: Uint8Array
  try {
    data = Uint8Array.from(Buffer.from(base64, 'base64'))
  } catch {
    return undefined
  }
  if (data.length === 0) return undefined
  const mediaType = sniffImageMediaType(data)
  return mediaType === undefined ? undefined : { data, mediaType }
}

function extensionFor(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

/**
 * pi-ai replay cannot represent assistant ImageBlocks. Drop them before the
 * next request so replay metadata still lines up with remaining content.
 */
export function stripAssistantImages(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message
    const content = message.content.filter(block => block.type !== 'image')
    return content.length === message.content.length ? message : { ...message, content }
  })
}

export async function* injectHostedImages(
  source: AsyncIterable<StreamChunk>,
  capture: HostedCapture,
  save: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>,
): AsyncGenerator<StreamChunk> {
  let maxIndex = -1
  const tail: StreamChunk[] = []

  for await (const chunk of source) {
    if ('index' in chunk && typeof chunk.index === 'number') maxIndex = Math.max(maxIndex, chunk.index)
    if (chunk.type === 'usage' || chunk.type === 'finish') {
      tail.push(chunk)
      continue
    }
    yield chunk
  }

  for (const image of capture.images) {
    const decoded = decodeHostedImage(image.base64)
    if (decoded === undefined) continue
    try {
      const attachment = await save({
        data: decoded.data,
        mediaType: decoded.mediaType,
        name: `generated.${extensionFor(decoded.mediaType)}`,
      })
      const index = maxIndex + 1
      maxIndex = index
      yield { type: 'block-start', index, blockType: 'image' }
      yield { type: 'block-end', index, block: { type: 'image', attachment } }
    } catch {
      // Keep the text answer when the attachment store rejects the raster.
    }
  }

  yield* tail
}
