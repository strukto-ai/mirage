import { describe, expect, it } from 'vitest'

import { statFingerprint } from './fingerprint.ts'

describe('statFingerprint', () => {
  it('composites all three inputs', () => {
    expect(statFingerprint('etag-1', '2026-01-01T00:00:00', 5)).toBe('etag-1|2026-01-01T00:00:00|5')
  })

  it('falls back to mtime and size with no native version', () => {
    expect(statFingerprint(null, '2026-01-01T00:00:00', 5)).toBe('|2026-01-01T00:00:00|5')
  })

  it('handles missing fields', () => {
    expect(statFingerprint(null, null, null)).toBe('||None')
  })

  it('moves when an unchanged etag accompanies a changed size', () => {
    const before = statFingerprint('lazy-etag', '2026-09-15T16:09:51+00:00', 4)
    const after = statFingerprint('lazy-etag', '2026-09-15T16:09:51+00:00', 11)
    expect(before).not.toBe(after)
  })

  it('moves when an unchanged etag accompanies a changed modified', () => {
    const before = statFingerprint('lazy-etag', '2026-09-15T16:09:51+00:00', 4)
    const after = statFingerprint('lazy-etag', '2026-09-15T16:30:18+00:00', 4)
    expect(before).not.toBe(after)
  })

  it('does not confuse a zero size with an absent one', () => {
    expect(statFingerprint('e', 'T', 0)).not.toBe(statFingerprint('e', 'T', null))
  })
})
