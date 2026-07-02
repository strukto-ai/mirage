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

import { resolveQdrantConfig } from '../../resource/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { ScopeLevel, detectScope } from './scope.ts'

const config = resolveQdrantConfig({
  groupBy: ['label', 'kind'],
  idField: 'id',
  textField: 'name',
  blobField: 'image_bytes',
  blobExt: 'png',
  vectorField: 'vector',
})

function ps(p: string): PathSpec {
  return new PathSpec({ resourcePath: stripSlash(p), virtual: p, directory: p })
}

describe('qdrant scope', () => {
  it('root in multi-collection mode', () => {
    expect(detectScope(ps('/'), config).level).toBe(ScopeLevel.ROOT)
  })

  it('collection is a group dir', () => {
    const s = detectScope(ps('/animals'), config)
    expect(s.level).toBe(ScopeLevel.GROUP_DIR)
    expect(s.table).toBe('animals')
    expect(s.filters).toEqual({})
  })

  it('nested group dir binds a filter', () => {
    expect(detectScope(ps('/animals/cat'), config).filters).toEqual({ label: 'cat' })
  })

  it('row json', () => {
    const s = detectScope(ps('/animals/cat/big/3.json'), config)
    expect(s.level).toBe(ScopeLevel.ROW)
    expect(s.rowId).toBe('3')
    expect(s.kind).toBe('json')
    expect(s.filters).toEqual({ label: 'cat', kind: 'big' })
  })

  it('row text', () => {
    const s = detectScope(ps('/animals/cat/big/3.txt'), config)
    expect(s.kind).toBe('txt')
  })

  it('row blob', () => {
    const s = detectScope(ps('/animals/cat/big/3.png'), config)
    expect(s.kind).toBe('blob')
  })

  it('single-collection pin elides the collection level', () => {
    const pinned = resolveQdrantConfig({
      collection: 'animals',
      groupBy: ['label', 'kind'],
      idField: 'id',
    })
    const s = detectScope(ps('/cat/big'), pinned)
    expect(s.level).toBe(ScopeLevel.GROUP_DIR)
    expect(s.filters).toEqual({ label: 'cat', kind: 'big' })
  })
})
