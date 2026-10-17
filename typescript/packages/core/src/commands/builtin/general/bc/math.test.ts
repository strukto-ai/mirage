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
import { callFunction } from './math.ts'
import { renderNumber } from './render.ts'

describe('bc small math arguments', () => {
  for (const scale of [0, 1, 20, 100]) {
    for (const sign of [-1n, 1n]) {
      for (const name of ['s', 'a', 'c']) {
        it(`${name} truncates a correction at scale ${scale}, sign ${sign}`, () => {
          const result = callFunction(name, { coefficient: sign, scale }, scale)
          const expected = name === 'c' && scale > 0 ? '.' + '9'.repeat(scale) : '0'
          expect(renderNumber(result, 10)).toBe(expected)
        })
      }
    }
  }
})
