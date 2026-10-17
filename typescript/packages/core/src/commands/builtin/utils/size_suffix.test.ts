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

import { decimalValue, parseBase0, sizeSuffixes } from './size_suffix.ts'

describe('sizeSuffixes', () => {
  it('maps a letter to its binary power', () => {
    const table = sizeSuffixes('KMG')
    expect(table.K).toBe(1024)
    expect(table.M).toBe(1024 ** 2)
    expect(table.G).toBe(1024 ** 3)
  })

  it('B form is decimal, iB form is binary', () => {
    const table = sizeSuffixes('k')
    expect(table.k).toBe(1024)
    expect(table.kB).toBe(1000)
    expect(table.kiB).toBe(1024)
  })

  it('the letter b is 512 with no compound forms', () => {
    expect(sizeSuffixes('b')).toEqual({ b: 512 })
  })

  it('preserves case instead of folding it', () => {
    expect(Object.keys(sizeSuffixes('kK')).sort()).toEqual(['K', 'KB', 'KiB', 'k', 'kB', 'kiB'])
  })

  it('rejects an unknown letter', () => {
    expect(() => sizeSuffixes('w')).toThrow("unknown size suffix letter 'w'")
  })
})

describe('parseBase0', () => {
  it('reads hex, octal and decimal', () => {
    expect(parseBase0('0x400')).toBe(1024n)
    expect(parseBase0('0X10')).toBe(16n)
    expect(parseBase0('010')).toBe(8n)
    expect(parseBase0('007')).toBe(7n)
    expect(parseBase0('1010')).toBe(1010n)
    expect(parseBase0('0')).toBe(0n)
  })
})

describe('decimalValue', () => {
  it('reads a number however long', () => {
    const digits = '9'.repeat(5000)
    expect(decimalValue(digits)).toBe(10n ** 5000n - 1n)
    expect(decimalValue('000123')).toBe(123n)
    expect(parseBase0(digits)).toBe(10n ** 5000n - 1n)
  })
})
