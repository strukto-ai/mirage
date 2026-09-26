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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { driveFingerprint } from './fingerprint.ts'

// integ/fixtures/gdrive/fingerprint.json is the contract: the python suite
// (tests/core/gdrive/test_fingerprint.py) asserts the same rows, so a chain
// changed in one tree without the other fails both. The coalescing operator
// is exactly where the two hosts drift silently -- this host's `??` keeps ""
// where python's `or` skips it -- and a shared table is the only thing that
// compares them against one answer.
const FIXTURE = new URL('../../../../../../integ/fixtures/gdrive/fingerprint.json', import.meta.url)

interface Case {
  md5: string | number | null
  head_revision: string | null
  modified: string | null
  expected: string | null
}

const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Case>

describe('driveFingerprint against the shared table', () => {
  it('has a non-empty table', () => {
    // A fixture that failed to resolve reads as zero cases, and a loop over
    // zero cases passes without asserting anything.
    expect(Object.keys(CASES).length).toBeGreaterThanOrEqual(6)
  })

  for (const [name, c] of Object.entries(CASES)) {
    it(`matches ${name}`, () => {
      expect(driveFingerprint(c.md5, c.head_revision, c.modified)).toBe(c.expected)
    })
  }
})

describe('driveFingerprint', () => {
  it('prefers the md5 over a head revision and a stamp', () => {
    expect(driveFingerprint('abc', 'r3', '2026-01-01T00:00:00Z')).toBe('abc')
  })

  it('carries a binary file with no md5 on its head revision', () => {
    // Drive withholds md5Checksum for some binary files; the head revision is
    // the second content token, and dropping this step would send them to a
    // timestamp while the read still stamped a revision.
    expect(driveFingerprint(null, 'r3', '2026-01-01T00:00:00Z')).toBe('r3')
  })

  it('leaves a native file its stamp, the only token it has', () => {
    // Drive populates headRevisionId only for files with binary content, so a
    // gdoc/gsheet/gslide reaches step 3 or nothing at all. A two-step chain
    // hands every native file null, which makes _probe answer UNKNOWN and
    // clear the whole mount index on every native read.
    expect(driveFingerprint(null, null, '2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z')
  })

  it('treats an empty string as absent, not as a value', () => {
    // The inputs that actually arrive are '' and not null: IndexEntry
    // .remoteTime defaults to '' and statFromApi does `item.modifiedTime ??
    // ''`. This host must coalesce with `||`: `??` keeps '' and returns it,
    // which escapes the `fingerprint === null` guards in the reconcile probe
    // and the drift check, so TypeScript would compare a '' token and raise a
    // spurious ContentDriftError where the python twin's `or` chain answers
    // None and treats the entry as unverifiable.
    expect(driveFingerprint('', '', '')).toBeNull()
  })

  it('answers null when every candidate is absent', () => {
    expect(driveFingerprint(null, null, null)).toBeNull()
  })

  it('skips a non-string candidate', () => {
    // IndexEntry.extra is Record<string, unknown> and a Redis-restored index
    // can hold whatever was serialized into it. Without a typeof guard this
    // host would return a number, while the python twin returned an int and
    // `==`-compared it against stat's string -- the same silent split the
    // empty-string case exists to catch, one host at a time.
    expect(driveFingerprint(12345, 'r3', 'T')).toBe('r3')
  })
})
