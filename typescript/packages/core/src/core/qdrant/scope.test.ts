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

import { QdrantAccessor } from '../../accessor/qdrant.ts'
import {
  resolveQdrantConfig,
  type QdrantConfig,
  type QdrantConfigResolved,
} from '../../vfs/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { INVALID, ROOT, makeDetectScope, type DetectFn } from '../hierarchy/scope.ts'
import { detectFor, filtersOf, scopesFor, tableOf } from './scope.ts'

function cfg(over: Partial<QdrantConfig> = {}): QdrantConfigResolved {
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

function detect(c: QdrantConfigResolved): DetectFn {
  return makeDetectScope(scopesFor(c))
}

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('qdrant scope', () => {
  it('root in multi-collection mode', () => {
    expect(detect(config)(ps('/')).kind).toBe(ROOT)
  })

  it('collection is a group dir', () => {
    const match = detect(config)(ps('/animals'))
    expect(match.kind).toBe('group')
    expect(tableOf(config, match)).toBe('animals')
    expect(filtersOf(config, match)).toEqual({})
  })

  it('nested group dir binds a filter', () => {
    const match = detect(config)(ps('/animals/cat'))
    expect(match.kind).toBe('group')
    expect(filtersOf(config, match)).toEqual({ label: 'cat' })
  })

  it('row json', () => {
    const match = detect(config)(ps('/animals/cat/big/3.json'))
    expect(match.kind).toBe('row_json')
    expect(match.slots.row_id).toBe('3')
    expect(filtersOf(config, match)).toEqual({ label: 'cat', kind: 'big' })
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

  it('too-deep paths are invalid', () => {
    expect(detect(config)(ps('/animals/cat/big/3.json/extra')).kind).toBe(INVALID)
  })

  it('pinned collection elides the collection segment', () => {
    const pinned = cfg({ collection: 'animals' })
    const match = detect(pinned)(ps('/cat/big'))
    expect(match.kind).toBe('group')
    expect(tableOf(pinned, match)).toBe('animals')
    expect(filtersOf(pinned, match)).toEqual({ label: 'cat', kind: 'big' })
  })

  it('decodes escaped group segments back to payload values', () => {
    const pinned = cfg({ collection: 'animals', groupBy: ['label'] })
    expect(filtersOf(pinned, detect(pinned)(ps('/a∕b')))).toEqual({ label: 'a/b' })
    expect(filtersOf(pinned, detect(pinned)(ps('/a⁄∕b')))).toEqual({ label: 'a∕b' })
    expect(filtersOf(pinned, detect(pinned)(ps('/⁄')))).toEqual({ label: '' })
    expect(filtersOf(pinned, detect(pinned)(ps('/⁄.env')))).toEqual({ label: '.env' })
  })

  it('detectFor caches per accessor', () => {
    const accessor = new QdrantAccessor(config)
    expect(detectFor(accessor)).toBe(detectFor(accessor))
    const other = new QdrantAccessor(cfg({ collection: 'animals', groupBy: ['label'] }))
    expect(detectFor(other)(ps('/cat/3.json')).kind).toBe('row_json')
  })
})
