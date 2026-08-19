/** Per-request bag for hosted Responses output that pi-ai drops. */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface HostedImage {
  id?: string
  base64: string
}

export interface HostedCapture {
  images: HostedImage[]
}

export const hostedCapture = new AsyncLocalStorage<HostedCapture>()

export function currentHostedCapture(): HostedCapture | undefined {
  return hostedCapture.getStore()
}

/** Keep ALS alive across each iterator step so the OpenAI SDK fetch inherits it. */
export function iterateInCapture<T>(
  capture: HostedCapture,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      return {
        next: () => hostedCapture.run(capture, () => iterator.next()),
        return: (value?: unknown) => hostedCapture.run(
          capture,
          () => iterator.return?.(value) ?? Promise.resolve({ done: true as const, value: undefined }),
        ),
        throw: (error?: unknown) => hostedCapture.run(
          capture,
          () => iterator.throw?.(error) ?? Promise.reject(error),
        ),
      }
    },
  }
}
