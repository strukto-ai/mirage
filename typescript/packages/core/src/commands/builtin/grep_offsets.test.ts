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
import { prefixOf } from './grep_offsets.ts'

describe('prefixOf', () => {
  it('puts the line number before the byte offset', () => {
    expect(prefixOf(2, 4)).toBe('2:4:')
  })

  it('omits a field that is off', () => {
    expect([prefixOf(2, null), prefixOf(null, 4)]).toEqual(['2:', '4:'])
  })

  it('is empty when neither flag is set', () => {
    expect(prefixOf(null, null)).toBe('')
  })

  it('renders a context line with dashes throughout', () => {
    expect(prefixOf(3, 12, false)).toBe('3-12-')
  })
})
