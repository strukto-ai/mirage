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
import { buildQuery, globRegex } from './find.ts'

function matches(cond: Record<string, unknown>, value: string): boolean {
  const regex = cond as { $regex: string; $options?: string }
  return new RegExp(regex.$regex, regex.$options ?? '').test(value)
}

describe('globRegex', () => {
  it('keeps * within a path segment', () => {
    const rx = globRegex('*.csv')
    expect(rx).not.toBeNull()
    expect(new RegExp(`^${String(rx)}$`).test('b.csv')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('sub/b.csv')).toBe(false)
  })

  it('translates ? to a single non-slash char', () => {
    const rx = globRegex('a?.txt')
    expect(new RegExp(`^${String(rx)}$`).test('ab.txt')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('a.txt')).toBe(false)
  })

  it('escapes regex literals', () => {
    const rx = globRegex('a+b.txt')
    expect(new RegExp(`^${String(rx)}$`).test('a+b.txt')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('aab.txt')).toBe(false)
  })

  it('bails on character classes', () => {
    expect(globRegex('[ab].txt')).toBeNull()
  })
})

describe('buildQuery', () => {
  it('prefix only', () => {
    expect(buildQuery('data/', {}, true)).toEqual({ filename: { $regex: '^data/' } })
  })

  it('name matches files and markers at any depth', () => {
    const query = buildQuery('data/', { name: '*.csv' }, true) as {
      $and: { filename: Record<string, unknown> }[]
    }
    const nameCond = query.$and[1]?.filename ?? {}
    expect(matches(nameCond, 'data/b.csv')).toBe(true)
    expect(matches(nameCond, 'data/sub/deep.csv')).toBe(true)
    expect(matches(nameCond, 'data/sub.csv/')).toBe(true)
    expect(matches(nameCond, 'data/b.txt')).toBe(false)
  })

  it('iname is case-insensitive', () => {
    const query = buildQuery('', { iname: '*.CSV' }, true) as { filename: Record<string, unknown> }
    expect(query.filename.$options).toBe('i')
    expect(matches(query.filename, 'b.csv')).toBe(true)
  })

  it('type narrows to files or markers', () => {
    expect(buildQuery('', { type: 'f' }, true)).toEqual({
      filename: { $not: { $regex: '/$' } },
    })
    expect(buildQuery('', { type: 'd' }, true)).toEqual({ filename: { $regex: '/$' } })
  })

  it('size lets markers through', () => {
    const query = buildQuery('', { minSize: 1, maxSize: 100 }, true) as {
      $or: Record<string, unknown>[]
    }
    expect(query.$or).toContainEqual({ length: { $gte: 1, $lte: 100 } })
    expect(query.$or).toContainEqual({ filename: { $regex: '/$' } })
  })

  it('no pushdown keeps prefix only', () => {
    expect(buildQuery('data/', { name: '*.csv', type: 'f', minSize: 1 }, false)).toEqual({
      filename: { $regex: '^data/' },
    })
  })

  it('unpushable glob falls back to prefix', () => {
    expect(buildQuery('data/', { name: '[ab].csv' }, true)).toEqual({
      filename: { $regex: '^data/' },
    })
  })
})
