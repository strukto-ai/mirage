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
import { exitCodeFor } from './grep_scan.ts'

describe('exitCodeFor', () => {
  it('is 0 for a match and 1 for none', () => {
    expect(exitCodeFor(true, false, false)).toBe(0)
    expect(exitCodeFor(false, false, false)).toBe(1)
  })

  it('lets an unread operand outrank a match', () => {
    expect(exitCodeFor(true, true, false)).toBe(2)
    expect(exitCodeFor(false, true, false)).toBe(2)
  })

  it('answers a match under -q despite an error', () => {
    expect(exitCodeFor(true, true, true)).toBe(0)
    expect(exitCodeFor(false, true, true)).toBe(2)
  })
})
