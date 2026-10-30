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
import { DEFAULT_TYPES } from './rg_types.ts'

// Twin of python/tests/utils/generated/test_rg_types.py.
describe('the generated rg type table', () => {
  it("holds ripgrep's defaults", () => {
    expect(DEFAULT_TYPES.py).toEqual(['*.py', '*.pyi'])
    expect(DEFAULT_TYPES.rust).toEqual(['*.rs'])
    expect(DEFAULT_TYPES.make).not.toContain('Makefile')
    expect(DEFAULT_TYPES.make).toContain('[Mm]akefile')
  })

  it('holds only types rg can select', () => {
    const names = Object.keys(DEFAULT_TYPES)
    expect(names).not.toContain('all')
    expect(names).toEqual([...names].sort())
    for (const [name, globs] of Object.entries(DEFAULT_TYPES)) {
      expect(name).toMatch(/^[\p{L}\p{N}]+$/u)
      expect(globs.length).toBeGreaterThan(0)
      expect([...globs]).toEqual([...new Set(globs)].sort())
    }
  })
})
