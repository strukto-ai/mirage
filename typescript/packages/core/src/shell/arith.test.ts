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
import { plainDecimal } from './arith.ts'

describe('plainDecimal', () => {
  it('reads ascii digits', () => {
    expect(plainDecimal('42')).toBe(42n)
    expect(plainDecimal(' 7\n')).toBe(7n)
  })

  it('wraps to 64 bits', () => {
    expect(plainDecimal('9223372036854775808')).toBe(-9223372036854775808n)
    expect(plainDecimal('18446744073709551617')).toBe(1n)
  })

  it('leaves the rest to the evaluator', () => {
    for (const text of ['', '0', '010', '1+1', '-3', 'x', '\u0663']) {
      expect(plainDecimal(text)).toBeNull()
    }
  })
})
