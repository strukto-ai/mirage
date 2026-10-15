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
import { statFromItem } from './readdir.ts'

// Shared with the python suite, so the two hosts answer one table.
const FIXTURE = new URL('../../../../../../integ/fixtures/gdrive/fingerprint.json', import.meta.url)

interface Case {
  resource_type: string
  md5: string | number | null
  head_revision: string | null
  modified: string | null
  expected: string | null
}

const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Case>

describe('driveFingerprint against the shared table', () => {
  it('has a non-empty table', () => {
    expect(Object.keys(CASES).length).toBeGreaterThanOrEqual(8)
  })

  for (const [name, c] of Object.entries(CASES)) {
    it(`matches ${name}`, () => {
      expect(driveFingerprint(c.resource_type, c.md5, c.head_revision, c.modified)).toBe(c.expected)
    })
  }
})

describe('a listed row', () => {
  it('answers the md5 of a file with content', () => {
    const row = statFromItem({
      id: 'f',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      modifiedTime: '2026-01-01T00:00:00Z',
      md5Checksum: 'abc',
      headRevisionId: 'r3',
    })
    expect(row.fingerprint).toBe('abc')
  })

  it('answers the stamp of a doc', () => {
    const row = statFromItem({
      id: 'd',
      name: 'notes',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-01-01T00:00:00Z',
    })
    expect(row.fingerprint).toBe('2026-01-01T00:00:00Z')
  })
})
