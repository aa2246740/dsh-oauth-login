/** Peek Responses SSE for hosted image_generation_call items pi-ai ignores. */

import { currentHostedCapture } from './hosted-capture.ts'
import { collectHostedImagesFromEvent } from './hosted-images.ts'

const TAPPED = Symbol('dsh-oauth-hosted-tap')

type TappableFetch = typeof fetch & { [TAPPED]?: true }
type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestMethod(input: FetchInput, init?: FetchInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase()
  if (typeof input !== 'string' && !(input instanceof URL) && input.method.length > 0) {
    return input.method.toUpperCase()
  }
  return 'GET'
}

export function isResponsesRequest(input: FetchInput, init?: FetchInit): boolean {
  if (requestMethod(input, init) !== 'POST') return false
  try {
    const path = new URL(requestUrl(input)).pathname
    return path === '/responses' || path.endsWith('/responses')
  } catch {
    return false
  }
}

function parseSseBlock(block: string): unknown {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (data.length === 0 || data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

export function consumeResponsesSseText(text: string, onEvent: (event: unknown) => void): string {
  const parts = text.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    const event = parseSseBlock(block)
    if (event !== undefined) onEvent(event)
  }
  return rest
}

function peekResponsesBody(body: ReadableStream<Uint8Array>, onEvent: (event: unknown) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer = consumeResponsesSseText(buffer + decoder.decode(chunk, { stream: true }), onEvent)
    },
    flush(controller) {
      if (buffer.length === 0) return
      const event = parseSseBlock(buffer)
      if (event !== undefined) onEvent(event)
      void controller
    },
  }))
}

export function tapResponsesResponse(response: Response, onEvent: (event: unknown) => void): Response {
  if (response.body === null) return response
  return new Response(peekResponsesBody(response.body, onEvent), response)
}

export function wrapFetchForHostedOutput(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const capture = currentHostedCapture()
    if (capture === undefined || !isResponsesRequest(input, init)) return await fetchImpl(input, init)
    const response = await fetchImpl(input, init)
    return tapResponsesResponse(response, event => collectHostedImagesFromEvent(event, capture.images))
  }
}

export function installHostedOutputFetch(): void {
  const current = globalThis.fetch as TappableFetch
  if (current[TAPPED] === true) return
  const next = Object.assign(wrapFetchForHostedOutput(current), { [TAPPED]: true as const })
  globalThis.fetch = next
}
