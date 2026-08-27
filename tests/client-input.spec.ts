import { describe, expect, it } from 'vitest'
import { applyDraftChange } from '../src/client/draft-input.ts'

describe('Pi login credential input', () => {
  it('captures the input value before React clears the synthetic event', () => {
    type Drafts = Record<string, string>
    let pending: ((current: Drafts) => Drafts) | undefined
    const event: { currentTarget: { value: string } | null } = {
      currentTarget: { value: 'test-key-never-submitted' },
    }

    applyDraftChange(
      'zai-coding-cn',
      event as { currentTarget: { value: string } },
      updater => { pending = updater },
    )
    event.currentTarget = null

    expect(pending?.({ existing: 'keep' })).toEqual({
      existing: 'keep',
      'zai-coding-cn': 'test-key-never-submitted',
    })
  })
})
