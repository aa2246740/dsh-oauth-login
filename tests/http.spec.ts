import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher } from 'undici'
import { configureOAuthHttpTransport, resolveOAuthProxy } from '../src/http.ts'

describe('OAuth HTTP transport', () => {
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined

  afterEach(async () => {
    if (previousDispatcher !== undefined) {
      const { setGlobalDispatcher } = await import('undici')
      setGlobalDispatcher(previousDispatcher)
      previousDispatcher = undefined
    }
  })

  it('uses proxy-aware undici without mutating process environment', async () => {
    const proxyEnvBefore = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /proxy/i.test(key)),
    )
    previousDispatcher = getGlobalDispatcher()
    await configureOAuthHttpTransport({
      env: {},
      platform: 'linux',
      candidates: [],
    })

    expect(getGlobalDispatcher().constructor.name).toBe('EnvHttpProxyAgent')
    const proxyEnvAfter = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /proxy/i.test(key)),
    )
    expect(proxyEnvAfter).toEqual(proxyEnvBefore)
  })

  it('keeps an inherited proxy authoritative and skips discovery', async () => {
    const readSystemProxy = vi.fn(async () => 'http://127.0.0.1:9000')
    const probe = vi.fn(async () => true)

    await expect(resolveOAuthProxy({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      platform: 'darwin',
      readSystemProxy,
      probe,
    })).resolves.toEqual({ source: 'environment' })
    expect(readSystemProxy).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('prefers the explicit DSH OAuth proxy over every discovered proxy', async () => {
    const readSystemProxy = vi.fn(async () => 'http://127.0.0.1:9000')
    const probe = vi.fn(async () => true)

    await expect(resolveOAuthProxy({
      env: { DSH_OAUTH_PROXY: 'http://127.0.0.1:45678' },
      platform: 'darwin',
      readSystemProxy,
      probe,
    })).resolves.toEqual({
      source: 'explicit',
      proxyUrl: 'http://127.0.0.1:45678/',
    })
    expect(readSystemProxy).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('uses a working macOS system proxy before probing common loopback ports', async () => {
    const probe = vi.fn(async (url: string) => url === 'http://127.0.0.1:9000/')

    await expect(resolveOAuthProxy({
      env: {},
      platform: 'darwin',
      readSystemProxy: async () => 'http://127.0.0.1:9000',
      probe,
      candidates: ['http://127.0.0.1:45678'],
    })).resolves.toEqual({
      source: 'system',
      proxyUrl: 'http://127.0.0.1:9000/',
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('selects the first verified local HTTP CONNECT proxy', async () => {
    const probe = vi.fn(async (url: string) => url.endsWith(':45678/'))

    await expect(resolveOAuthProxy({
      env: {},
      platform: 'linux',
      probe,
      candidates: [
        'http://127.0.0.1:7890',
        'http://127.0.0.1:45678',
      ],
    })).resolves.toEqual({
      source: 'loopback',
      proxyUrl: 'http://127.0.0.1:45678/',
    })
  })

  it('falls back to direct transport when no proxy can be verified', async () => {
    await expect(resolveOAuthProxy({
      env: {},
      platform: 'linux',
      probe: async () => false,
      candidates: ['http://127.0.0.1:45678'],
    })).resolves.toEqual({ source: 'direct' })
  })
})
