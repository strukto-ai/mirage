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

import { RACY_WINDOW_NS } from '@struktoai/mirage-core/utils/constants'
import { describe, expect, it } from 'vitest'
import { tokenOf } from './fingerprint.ts'

const WRITTEN_MS = 1_700_000_000_123
const SETTLED = BigInt(WRITTEN_MS) * 1_000_000n + RACY_WINDOW_NS

function file(text: string, lastModified = WRITTEN_MS): File {
  return new File([text], 'f', { lastModified })
}

describe('tokenOf', () => {
  it('names a settled file by its size and millisecond', () => {
    expect(tokenOf(file('abc'), SETTLED)).toBe('3:1700000000123')
  })

  it('gives a file inside the racy window none', () => {
    expect(tokenOf(file('abc'), SETTLED - 1n)).toBeNull()
  })

  it('moves when a later write lands on a later millisecond', () => {
    const later = SETTLED + 1_000_000n
    expect(tokenOf(file('abc'), later)).not.toBe(tokenOf(file('xyz', WRITTEN_MS + 1), later))
  })
})
