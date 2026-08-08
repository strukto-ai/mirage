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
import { planFlush } from './flush.ts'

const enc = new TextEncoder()

describe('planFlush', () => {
  it('ships a tail when the handle only extended the file', () => {
    expect(planFlush(3, 3, enc.encode('abcXYZ'))).toEqual(['append', enc.encode('XYZ')])
  })

  it('ships the whole file when history was rewritten', () => {
    expect(planFlush(3, 0, enc.encode('ZZZdef'))).toEqual(['write', enc.encode('ZZZdef')])
  })

  it('ships the whole file for a new one', () => {
    expect(planFlush(0, 0, enc.encode('fresh'))).toEqual(['write', enc.encode('fresh')])
  })

  it('ships the whole file when the buffer shrank', () => {
    expect(planFlush(6, 6, enc.encode('abc'))).toEqual(['write', enc.encode('abc')])
  })
})
