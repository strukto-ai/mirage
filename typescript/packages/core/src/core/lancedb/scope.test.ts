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

import { stripSlash } from '../../utils/slash.ts'
import { describe, expect, it } from 'vitest'

import { resolveLanceDBConfig } from '../../resource/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import { ScopeLevel, detectScope } from './scope.ts'

const config = resolveLanceDBConfig({
  uri: '/tmp/db',
  groupBy: ['label', 'kind'],
  idColumn: 'id',
  blobColumn: 'image_bytes',
  blobExt: 'png',
  vectorColumn: 'vector',
})

function ps(p: string): PathSpec {
  return new PathSpec({ resourcePath: stripSlash(p), virtual: p, directory: p })
}

describe('lancedb scope', () => {
  it('root in multi-table mode', () => {
    expect(detectScope(ps('/'), config).level).toBe(ScopeLevel.ROOT)
  })

  it('table is a group dir', () => {
    const s = detectScope(ps('/animals'), config)
    expect(s.level).toBe(ScopeLevel.GROUP_DIR)
    expect(s.table).toBe('animals')
    expect(s.filters).toEqual({})
  })

  it('nested group dir binds a filter', () => {
    expect(detectScope(ps('/animals/cat'), config).filters).toEqual({ label: 'cat' })
  })

  it('row card', () => {
    const s = detectScope(ps('/animals/cat/big/3.md'), config)
    expect(s.level).toBe(ScopeLevel.ROW)
    expect(s.rowId).toBe('3')
    expect(s.blob).toBe(false)
    expect(s.filters).toEqual({ label: 'cat', kind: 'big' })
  })

  it('row blob', () => {
    const s = detectScope(ps('/animals/cat/big/3.png'), config)
    expect(s.blob).toBe(true)
  })

  it('single-table pin elides the table level', () => {
    const pinned = resolveLanceDBConfig({
      uri: '/tmp/db',
      table: 'animals',
      groupBy: ['label', 'kind'],
      idColumn: 'id',
    })
    const s = detectScope(ps('/cat/big'), pinned)
    expect(s.level).toBe(ScopeLevel.GROUP_DIR)
    expect(s.filters).toEqual({ label: 'cat', kind: 'big' })
  })
})
