// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { statFingerprint } from './fingerprint.ts'

describe('statFingerprint', () => {
  it('joins the etag and the size', () => {
    expect(statFingerprint('etag-1', '2026-01-01T00:00:00', 5)).toBe('etag-1|5')
  })

  it('substitutes the stamp with no native version', () => {
    expect(statFingerprint(null, '2026-01-01T00:00:00', 5)).toBe('2026-01-01T00:00:00|5')
  })

  it('handles missing fields', () => {
    expect(statFingerprint(null, null, null)).toBe('|None')
  })

  it('moves when an unchanged etag accompanies a changed size', () => {
    // Probed on Nextcloud 30: its WebDAV ETag comes off an mtime with
    // one-second granularity, so two writes inside the same second
    // answer the SAME etag and the SAME stamp even though the content
    // and its size changed. The size is the only field that moved, and
    // returning the etag alone threw it away.
    const before = statFingerprint('lazy-etag', '2026-09-15T16:09:51+00:00', 4)
    const after = statFingerprint('lazy-etag', '2026-09-15T16:09:51+00:00', 11)
    expect(before).not.toBe(after)
  })

  it('does not move when only the stamp moves on a versioned backend', () => {
    // The mirror of the case above, and why the stamp is not folded in
    // beside the etag. S3's single-part ETag and Dropbox's
    // content_hash are content-addressed: rewriting a file with
    // identical bytes leaves them alone while the stamp moves. Reading
    // that idempotent rewrite as an UPDATE would wake every consumer
    // for nothing, and the stamp cannot rescue the case above anyway,
    // since a stamp coarse enough to give two writes one etag gives
    // them one stamp.
    const before = statFingerprint('sha-1', '2026-09-15T16:09:51+00:00', 4)
    const after = statFingerprint('sha-1', '2026-09-15T16:30:18+00:00', 4)
    expect(before).toBe(after)
  })

  it('does not confuse a zero size with an absent one', () => {
    expect(statFingerprint('e', 'T', 0)).not.toBe(statFingerprint('e', 'T', null))
  })
})
