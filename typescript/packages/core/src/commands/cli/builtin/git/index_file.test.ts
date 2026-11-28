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
import { FileStat, FileType } from '../../../../types.ts'
import { unchanged, withFingerprint, type StagedEntry } from './index_file.ts'

const ENTRY: StagedEntry = { oid: '0'.repeat(40), mode: 0o100644, size: 3 }

function stat(fingerprint: string | null): FileStat {
  return new FileStat({ name: 'a.txt', size: 3, type: FileType.FILE, fingerprint })
}

describe('withFingerprint', () => {
  it('lets an entry find the file unchanged by the fingerprint it kept', () => {
    const kept = withFingerprint(ENTRY, stat('1:100.000000001'))
    expect([kept.dev, kept.ino]).not.toEqual([0, 0])
    expect(unchanged(kept, stat('1:100.000000001'))).toBe(true)
    expect(unchanged(kept, stat('1:100.000000002'))).toBe(false)
  })

  it('keeps nothing for a file the mount fingerprints not', () => {
    expect(withFingerprint(ENTRY, stat(null))).toEqual({ ...ENTRY, dev: 0, ino: 0 })
    expect(unchanged(ENTRY, stat('1:100.000000001'))).toBe(false)
    expect(unchanged(withFingerprint(ENTRY, stat('x')), stat(null))).toBe(false)
  })

  it('keeps the same two numbers Python keeps', () => {
    // An index one host writes, the other reads: both take the first eight
    // bytes of the fingerprint's SHA-1 as dev and ino.
    expect(withFingerprint(ENTRY, stat('1:100.000000001'))).toMatchObject({
      dev: 0x1c236b98,
      ino: 0x703ac08a,
    })
  })
})
