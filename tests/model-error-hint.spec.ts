import { LlmError, ProviderRequestId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/plugin-config.ts'
import {
  hintFailure,
  QUOTA_HINT,
  RATE_LIMIT_HINT,
  TRANSIENT_HINT,
  TRANSIENT_MODEL_CODES,
  withModelErrorHint,
} from '../src/model-error-hint.ts'

describe('withModelErrorHint', () => {
  it('keeps TIMEOUT routable and appends the send-again sentence', () => {
    const error = new LlmError('pi-ai stream idle timeout after 300000ms', 'TIMEOUT')
    const hinted = withModelErrorHint(error)
    expect(hinted).toBeInstanceOf(LlmError)
    expect(hinted).not.toBe(error)
    if (!(hinted instanceof LlmError)) throw new Error('expected LlmError')
    expect(hinted.code).toBe('TIMEOUT')
    expect(hinted.message).toContain('pi-ai stream idle timeout after 300000ms')
    expect(hinted.message).toContain(TRANSIENT_HINT)
  })

  it('tells RATE_LIMIT from QUOTA without changing either code', () => {
    const busy = withModelErrorHint(new LlmError('HTTP 429: rate limit reached', 'RATE_LIMIT', { status: 429 }))
    const empty = withModelErrorHint(new LlmError('You exceeded your current quota', 'QUOTA', { status: 429 }))
    if (!(busy instanceof LlmError) || !(empty instanceof LlmError)) throw new Error('expected LlmError')
    expect(busy.code).toBe('RATE_LIMIT')
    expect(busy.failure.status).toBe(429)
    expect(busy.message).toContain(RATE_LIMIT_HINT)
    expect(busy.message).not.toContain(QUOTA_HINT)
    expect(empty.code).toBe('QUOTA')
    expect(empty.message).toContain(QUOTA_HINT)
    expect(empty.message).not.toContain(RATE_LIMIT_HINT)
  })

  it('hints finish-chunk failures used by pi-ai 429/quota delivery', () => {
    const failure = hintFailure({ message: 'HTTP 429: rate limit reached', code: 'RATE_LIMIT', status: 429 })
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.status).toBe(429)
    expect(failure.message).toContain(RATE_LIMIT_HINT)
    expect(hintFailure(failure)).toBe(failure)
  })

  it('leaves AUTH, missing credentials, and already-hinted errors alone', () => {
    const missing = new LlmError('not signed in', 'MISSING_CREDENTIAL')
    expect(withModelErrorHint(missing)).toBe(missing)

    const auth = new LlmError('rejected', 'AUTH')
    expect(withModelErrorHint(auth)).toBe(auth)

    const hinted = new LlmError(`network down ${TRANSIENT_HINT}`, 'TRANSPORT')
    expect(withModelErrorHint(hinted)).toBe(hinted)

    expect(withModelErrorHint(new Error('plain'))).toBeInstanceOf(Error)
  })
})

describe('provider retry policy defaults', () => {
  it('keeps the RC8 official five-retry budget when config omits retryPolicy', () => {
    const policy = resolveRetryPolicy(undefined, 'dsh-oauth-login retryPolicy')
    expect(policy).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
    })
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect([...policy.retryableCodes]).toEqual([...TRANSIENT_MODEL_CODES])
  })

  it('accepts an empty plugin Config and a raised retry budget', () => {
    expect(Config({})).toMatchObject({ streamIdleTimeoutMs: 300_000 })
    expect(Config({
      retryPolicy: { mode: 'normal', maxRetries: 7 },
    })).toMatchObject({
      retryPolicy: { mode: 'normal', maxRetries: 7 },
    })
  })
})

describe('provider failure recovery compatibility', () => {
  const overloaded = 'Codex error: Our servers are currently overloaded. Please try again later.'
  const quota = '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2030-01-01 00:00:00 重置。"}'
  const policy = resolveRetryPolicy(undefined, 'recovery regression')
  if (policy.mode !== 'normal') throw new Error('expected normal policy')

  it('routes the exported Codex overloaded finish through the existing finite retry policy', () => {
    const failure = hintFailure({ message: overloaded, code: 'PI_AI_ERROR' }, 'pi-openai-codex')
    expect(failure.code).toBe('SERVER')
    expect(policy.retryableCodes).toContain(failure.code)
    expect(failure.message).toContain(overloaded)
    expect(failure.message).toContain(TRANSIENT_HINT)
    expect(hintFailure(failure, 'pi-openai-codex')).toBe(failure)
  })

  it.each(['1310', 1310])('does not retry Zhipu quota code %s as peak traffic', (code) => {
    const message = `429: ${JSON.stringify({ code, message: '您已达到每周/每月使用上限' })}`
    const failure = hintFailure({ message, code: 'RATE_LIMIT', status: 429 }, 'pi-zai-coding-cn')
    expect(failure.code).toBe('QUOTA')
    expect(policy.retryableCodes).not.toContain(failure.code)
    expect(failure.message).toContain(QUOTA_HINT)
    expect(failure.message).not.toContain(RATE_LIMIT_HINT)
    expect(failure.status).toBe(429)
    expect(hintFailure(failure, 'pi-zai-coding-cn')).toBe(failure)
  })

  it('keeps Zhipu 1305 busy failures retryable', () => {
    const message = '429: {"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}'
    const failure = hintFailure({ message, code: 'RATE_LIMIT' }, 'pi-zai-coding-cn')
    expect(failure.code).toBe('RATE_LIMIT')
    expect(policy.retryableCodes).toContain(failure.code)
  })

  it('preserves thrown-error metadata and cause when repairing the routable code', () => {
    const requestId = ProviderRequestId('recovery-probe-request')
    const error = new LlmError(overloaded, 'PI_AI_ERROR', {
      status: 503, providerRetryAfterMs: 1500, requestId,
    })
    const result = withModelErrorHint(error, 'pi-openai-codex')
    if (!(result instanceof LlmError)) throw new Error('expected LlmError')
    expect(result.code).toBe('SERVER')
    expect(result.failure).toMatchObject({ code: 'SERVER', status: 503, providerRetryAfterMs: 1500, requestId })
    expect(result.cause).toBe(error)
    const quotaError = withModelErrorHint(new LlmError(quota, 'RATE_LIMIT'), 'pi-zai-coding-cn')
    if (!(quotaError instanceof LlmError)) throw new Error('expected LlmError')
    expect(quotaError.code).toBe('QUOTA')
  })

  it.each(['AUTH', 'INVALID_REQUEST', 'QUOTA', 'ABORTED'])('does not override an already classified %s failure', (code) => {
    expect(hintFailure({ message: overloaded, code }, 'pi-openai-codex').code).toBe(code)
  })

  it('does not apply provider-specific repairs to unrelated routes or generic failures', () => {
    const failure = { message: overloaded, code: 'PI_AI_ERROR' }
    expect(hintFailure(failure, 'pi-anthropic')).toBe(failure)
    expect(hintFailure(failure)).toBe(failure)
    expect(hintFailure({ message: quota, code: 'RATE_LIMIT' }, 'pi-openai-codex').code).toBe('RATE_LIMIT')
    const unknown = { message: 'unknown provider failure', code: 'PI_AI_ERROR' }
    expect(hintFailure(unknown, 'pi-openai-codex')).toBe(unknown)
  })

  it.each([
    '429: {"code":"1305","message":"request example: code 1310"}',
    '429: {"message":"quota-like wording","request":{"code":"1310"}}',
    '429: {"code":"1310"',
  ])('does not infer quota from incidental text or malformed payloads: %s', (message) => {
    expect(hintFailure({ message, code: 'RATE_LIMIT' }, 'pi-zai-coding-cn').code).toBe('RATE_LIMIT')
  })
})
