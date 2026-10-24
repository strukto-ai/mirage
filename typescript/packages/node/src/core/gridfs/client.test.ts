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
import { prefixQuery, trashed } from './client.ts'

function pattern(query: Record<string, unknown>): RegExp {
  return new RegExp((query.filename as { $regex: string }).$regex)
}

// Twins of tests/core/gridfs/test_client.py.
describe('gridfs prefixQuery', () => {
  it('matches everything but the trash on an empty prefix', () => {
    const live = pattern(prefixQuery(''))
    expect(live.test('a.txt')).toBe(true)
    expect(live.test('team/a.txt')).toBe(true)
    expect(live.test(trashed('a.txt'))).toBe(false)
  })

  it('cannot reach the trash from a prefix', () => {
    // No mount key starts with a slash, so a scoped query never does.
    expect(pattern(prefixQuery('team/')).test(trashed('team/a.txt'))).toBe(false)
  })

  it('escapes regex metacharacters', () => {
    const scoped = pattern(prefixQuery('a+b (1)/'))
    expect(scoped.test('a+b (1)/x.txt')).toBe(true)
    expect(scoped.test('aab (1)/x.txt')).toBe(false)
  })
})

describe('gridfs trashed', () => {
  it('keeps the whole key', () => {
    expect(trashed('team/reports/a.txt')).toBe('/trash/team/reports/a.txt')
  })
})
