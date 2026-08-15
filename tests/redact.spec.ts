import { describe, expect, it } from 'vitest'
import { requirePiLoginProvider } from '../src/catalog.ts'
import { isSafeAuthUrl, safeMessage } from '../src/redact.ts'

describe('safeMessage', () => {
  it('redacts jwt-shaped tokens and oauth query values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signaturepart'
    expect(safeMessage(new Error(`failed ${jwt} access_token=abc.def`))).toBe(
      'failed [redacted token] access_token=[redacted]',
    )
  })
})

describe('isSafeAuthUrl', () => {
  it('allows each provider only on its official hosts', () => {
    expect(isSafeAuthUrl('https://auth.openai.com/oauth', requirePiLoginProvider('openai-codex'))).toBe(true)
    expect(isSafeAuthUrl('https://auth.x.ai/device', requirePiLoginProvider('xai'))).toBe(true)
    expect(isSafeAuthUrl('https://claude.ai/oauth/authorize', requirePiLoginProvider('anthropic'))).toBe(true)
    expect(isSafeAuthUrl('https://auth.x.ai/device', requirePiLoginProvider('openai-codex'))).toBe(false)
    expect(isSafeAuthUrl('http://auth.openai.com/oauth', requirePiLoginProvider('openai-codex'))).toBe(false)
    expect(isSafeAuthUrl('https://evil.example/login', requirePiLoginProvider('xai'))).toBe(false)
  })
})
