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

import { formatScore, scoreFromDistance } from './score.ts'

describe('scoreFromDistance', () => {
  it('converts distances to clamped similarities', () => {
    expect(scoreFromDistance(0)).toBe('1.00')
    expect(scoreFromDistance(0.25)).toBe('0.75')
    expect(scoreFromDistance(1)).toBe('0.00')
    expect(scoreFromDistance(2)).toBe('0.00')
  })

  it('collapses non-numeric values to 0.00', () => {
    expect(scoreFromDistance(null)).toBe('0.00')
    expect(scoreFromDistance(undefined)).toBe('0.00')
    expect(scoreFromDistance(true)).toBe('0.00')
    expect(scoreFromDistance('0.5')).toBe('0.00')
    expect(scoreFromDistance(Number.NaN)).toBe('0.00')
  })
})

describe('formatScore', () => {
  it('formats a provider score to two decimals', () => {
    expect(formatScore(0.92)).toBe('0.92')
    expect(formatScore(0.8)).toBe('0.80')
    expect(formatScore(1)).toBe('1.00')
  })

  it('returns null for non-numeric values', () => {
    expect(formatScore(null)).toBeNull()
    expect(formatScore(undefined)).toBeNull()
    expect(formatScore(true)).toBeNull()
    expect(formatScore('0.5')).toBeNull()
    expect(formatScore(Number.NaN)).toBeNull()
  })
})
