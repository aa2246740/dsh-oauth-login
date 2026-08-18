import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
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
  it('keeps the official two-retry budget when config omits retryPolicy', () => {
    const policy = resolveRetryPolicy(undefined, 'dsh-oauth-login retryPolicy')
    expect(policy).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
    })
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect([...policy.retryableCodes]).toEqual([...TRANSIENT_MODEL_CODES])
  })

  it('accepts an empty plugin Config and a raised retry budget', () => {
    expect(Config({})).toMatchObject({ streamIdleTimeoutMs: 300_000 })
    expect(Config({
      retryPolicy: { mode: 'normal', maxRetries: 4 },
    })).toMatchObject({
      retryPolicy: { mode: 'normal', maxRetries: 4 },
    })
  })
})
