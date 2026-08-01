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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveQdrantConfig } from '../../resource/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import type { QdrantRow } from './_client.ts'
import { readdir } from './readdir.ts'
import { blobBytes, renderJson, renderText } from './render.ts'

const ROW: QdrantRow = {
  id: 1,
  label: 'cat',
  kind: 'big',
  name: 'a big orange cat',
  image_bytes: 'UE5HLTE=',
}

const config = resolveQdrantConfig({
  idField: 'id',
  groupBy: ['label', 'kind'],
  textField: 'name',
  blobField: 'image_bytes',
  blobExt: 'png',
  vectorField: 'vector',
})

function accessor(): QdrantAccessor {
  return {
    config,
    listTables: () => Promise.resolve(['animals']),
    distinct: () => Promise.resolve(['big']),
    rowsMatching: () => Promise.resolve([ROW]),
  } as unknown as QdrantAccessor
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: virtual.replace(/^\//, '') })
}

describe('qdrant readdir sizes', () => {
  it('lists the row files of a leaf group', async () => {
    const out = await readdir(accessor(), spec('/animals/cat/big'), new RAMIndexCacheStore())
    expect(out).toEqual([
      '/animals/cat/big/1.json',
      '/animals/cat/big/1.txt',
      '/animals/cat/big/1.png',
    ])
  })

  it('seeds the exact rendered size of every row file', async () => {
    const idx = new RAMIndexCacheStore()
    await readdir(accessor(), spec('/animals/cat/big'), idx)
    const json = await idx.get('/animals/cat/big/1.json')
    expect(json.entry?.size).toBe(renderJson(ROW, config).byteLength)
    const txt = await idx.get('/animals/cat/big/1.txt')
    expect(txt.entry?.size).toBe(renderText(ROW, config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBe(blobBytes(ROW.image_bytes).byteLength)
  })

  it('lists without an index when none is given', async () => {
    const out = await readdir(accessor(), spec('/animals/cat/big'))
    expect(out).toHaveLength(3)
  })

  it('keeps listing when a blob value cannot be sized', async () => {
    // An undecodable blob must leave that one size unknown, not fail the
    // whole directory listing.
    const broken = { ...ROW, image_bytes: 42 }
    const acc = {
      config,
      listTables: () => Promise.resolve(['animals']),
      distinct: () => Promise.resolve(['big']),
      rowsMatching: () => Promise.resolve([broken]),
    } as unknown as QdrantAccessor
    const idx = new RAMIndexCacheStore()
    const out = await readdir(acc, spec('/animals/cat/big'), idx)
    expect(out).toHaveLength(3)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
    const json = await idx.get('/animals/cat/big/1.json')
    expect(json.entry?.size).toBe(renderJson(broken, config).byteLength)
  })
})
