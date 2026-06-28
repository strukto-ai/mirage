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

import { buildFilter, candidateIds, coerce, pointToRow } from './_client.ts'

describe('qdrant _client helpers', () => {
  it('coerces numeric strings only', () => {
    expect(coerce('5')).toBe(5)
    expect(coerce('-3')).toBe(-3)
    expect(coerce('cat')).toBe('cat')
  })

  it('keeps numeric strings that would not round-trip', () => {
    expect(coerce('007')).toBe('007')
    expect(coerce('05')).toBe('05')
    expect(coerce('-0')).toBe('-0')
  })

  it('builds a match filter, undefined when empty', () => {
    expect(buildFilter({})).toBeUndefined()
    expect(buildFilter({ label: 'cat', n: '2' })).toEqual({
      must: [
        { key: 'label', match: { value: 'cat' } },
        { key: 'n', match: { value: 2 } },
      ],
    })
  })

  it('maps a point to a row keyed by the point id', () => {
    const row = pointToRow({ id: 7, payload: { label: 'cat' } }, 'id')
    expect(row).toEqual({ label: 'cat', id: 7 })
  })

  it('produces id candidates by type, none for invalid ids', () => {
    expect(candidateIds('7')).toEqual([7])
    const uid = '11111111-1111-1111-1111-111111111111'
    expect(candidateIds(uid)).toEqual([uid])
    expect(candidateIds('__nf_missing__')).toEqual([])
  })
})
