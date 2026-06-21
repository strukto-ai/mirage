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
import { epochToIso, utcDateFolder } from './dates.ts'

describe('epochToIso', () => {
  it('formats whole seconds as second-precision ISO-Z', () => {
    expect(epochToIso(1609459200)).toBe('2021-01-01T00:00:00Z')
  })
  it('truncates sub-second input (parity with the Python converter)', () => {
    expect(epochToIso(1609459200.987)).toBe('2021-01-01T00:00:00Z')
  })
})

describe('utcDateFolder', () => {
  it('returns YYYY-MM-DD for a timestamp', () => {
    expect(utcDateFolder(1609459200000)).toBe('2021-01-01')
  })
})
