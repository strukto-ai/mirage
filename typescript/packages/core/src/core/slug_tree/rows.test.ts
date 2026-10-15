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

import { FileStat, FileType } from '../../types.ts'
import { dirRows, normalizeSlug, scalarString } from './rows.ts'

describe('normalizeSlug', () => {
  it('normalizes slashes', () => {
    expect(normalizeSlug('/guides//auth.md/', 'Chroma path')).toBe('/guides/auth.md')
  })

  it('names the backend in its refusals', () => {
    expect(() => normalizeSlug('//', 'Chroma path')).toThrow('Invalid empty Chroma path')
    expect(() => normalizeSlug('a/../b', 'Dify document slug')).toThrow(
      "Invalid Dify document slug segment: '..'",
    )
    expect(() => normalizeSlug('./a.md', 'Chroma path')).toThrow("Invalid Chroma path segment: '.'")
  })
})

describe('scalarString', () => {
  it('coerces primitives and rejects objects', () => {
    expect(scalarString('x')).toBe('x')
    expect(scalarString(5)).toBe('5')
    expect(scalarString(true)).toBe('true')
    expect(scalarString(null)).toBeNull()
    expect(scalarString({})).toBeNull()
  })
})

describe('dirRows', () => {
  it('lays each folder out by tree path', () => {
    const files = new Map([
      ['/guides/quickstart', 5],
      ['/api/reference', 3],
    ])
    const rows = dirRows(
      files,
      (path, size) => new FileStat({ name: path, type: FileType.FILE, size }),
    )
    expect([...rows.keys()].sort()).toEqual(['/', '/api', '/guides'])
    expect(rows.get('/')?.map((row) => [row.name, row.type])).toEqual([
      ['api', FileType.DIRECTORY],
      ['guides', FileType.DIRECTORY],
    ])
  })
})
