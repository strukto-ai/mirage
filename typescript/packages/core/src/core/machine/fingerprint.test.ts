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
import { RACY_WINDOW_NS } from '../../utils/constants.ts'
import type { PosixEntry } from '../posix/types.ts'
import { tokenOf } from './fingerprint.ts'

const WRITTEN_MS = 1_700_000_000_123
const SETTLED = BigInt(WRITTEN_MS) * 1_000_000n + RACY_WINDOW_NS
const UNASKED: PosixEntry = {
  kind: 'f',
  mode: 0o644,
  size: 12,
  mtime: 1_700_000_000,
  atime: 1_700_000_000,
  mtimeMs: WRITTEN_MS,
  atimeMs: WRITTEN_MS,
  uid: 1000,
  gid: 50,
  nlink: 1,
  blocks: 8,
  rel: '',
}
const ENTRY: PosixEntry = { ...UNASKED, askedNs: SETTLED }

describe('tokenOf', () => {
  it('names a settled entry by its size and millisecond', () => {
    expect(tokenOf(ENTRY)).toBe('12:1700000000123')
  })

  it('gives an entry inside the racy window none', () => {
    expect(tokenOf({ ...ENTRY, askedNs: SETTLED - 1n })).toBeNull()
  })

  it('gives an entry with no asking time kept none', () => {
    expect(tokenOf(UNASKED)).toBeNull()
  })
})
