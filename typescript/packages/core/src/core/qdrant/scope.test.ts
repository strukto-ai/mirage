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
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { resolveQdrantConfig, type QdrantConfig } from '../../vfs/qdrant/config.ts'
import { INVALID, makeDetectScope, type DetectFn } from '../hierarchy/scope.ts'
import { filtersOf } from '../vector/scope.ts'
import { scopesFor } from './scope.ts'

function cfg(over: Partial<QdrantConfig> = {}): ReturnType<typeof resolveQdrantConfig> {
  return resolveQdrantConfig({
    groupBy: ['label', 'kind'],
    idField: 'id',
    textField: 'name',
    blobField: 'image_bytes',
    blobExt: 'png',
    vectorField: 'vector',
    ...over,
  })
}

const config = cfg()

function detect(c: ReturnType<typeof resolveQdrantConfig>): DetectFn {
  return makeDetectScope(scopesFor(c))
}

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('qdrant scope', () => {
  it('row json', () => {
    const match = detect(config)(ps('/animals/cat/big/3.json'))
    expect(match.kind).toBe('row_json')
    expect(match.slots.row_id).toBe('3')
    expect(filtersOf(config.groupBy, match)).toEqual({ label: 'cat', kind: 'big' })
  })

  it('row text', () => {
    const match = detect(config)(ps('/animals/cat/big/3.txt'))
    expect(match.kind).toBe('row_text')
    expect(match.slots.row_id).toBe('3')
  })

  it('row blob', () => {
    const match = detect(config)(ps('/animals/cat/big/3.png'))
    expect(match.kind).toBe('row_blob')
    expect(match.slots.row_id).toBe('3')
  })

  it('text and blob leaves need their config fields', () => {
    const bare = resolveQdrantConfig({ groupBy: ['label', 'kind'] })
    expect(detect(bare)(ps('/animals/cat/big/3.txt')).kind).toBe(INVALID)
    expect(detect(bare)(ps('/animals/cat/big/3.png')).kind).toBe(INVALID)
    expect(detect(bare)(ps('/animals/cat/big/3.json')).kind).toBe('row_json')
  })
})
