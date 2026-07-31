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

import { describe, expect, it, vi } from 'vitest'

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveLanceDBConfig } from '../../resource/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import type { LanceDriver, LanceRow } from './_driver.ts'
import { readdir } from './readdir.ts'
import { renderCard } from './render.ts'

const ROW: LanceRow = {
  id: 1,
  label: 'cat',
  kind: 'big',
  name: 'a big orange cat',
}

const config = resolveLanceDBConfig({
  uri: '/tmp/db',
  groupBy: ['label', 'kind'],
  idColumn: 'id',
  titleColumn: 'name',
  blobColumn: 'image_bytes',
  blobExt: 'png',
  vectorColumn: 'vector',
})

function makeAccessor(): { accessor: LanceDBAccessor; rowsMatching: ReturnType<typeof vi.fn> } {
  const rowsMatching = vi.fn().mockResolvedValue([ROW])
  const driver = {
    listTables: vi.fn().mockResolvedValue(['animals']),
    tableColumns: vi
      .fn()
      .mockResolvedValue(['id', 'label', 'kind', 'name', 'image_bytes', 'vector']),
    distinct: vi.fn().mockResolvedValue(['big']),
    rowsMatching,
  } as unknown as LanceDriver
  return { accessor: new LanceDBAccessor(driver, config), rowsMatching }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: virtual.replace(/^\//, '') })
}

describe('lancedb readdir sizes', () => {
  it('selects every column except the vector and blob ones', async () => {
    const { accessor, rowsMatching } = makeAccessor()
    await readdir(accessor, spec('/animals/cat/big'), new RAMIndexCacheStore())
    expect(rowsMatching.mock.calls[0]?.[2]).toEqual(['id', 'label', 'kind', 'name'])
  })

  it('seeds the exact card size and leaves the blob unsized', async () => {
    const { accessor } = makeAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(accessor, spec('/animals/cat/big'), idx)
    const card = await idx.get('/animals/cat/big/1.md')
    expect(card.entry?.size).toBe(renderCard(ROW, config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
  })

  it('lists without an index when none is given', async () => {
    const { accessor } = makeAccessor()
    const out = await readdir(accessor, spec('/animals/cat/big'))
    expect(out).toEqual(['/animals/cat/big/1.md', '/animals/cat/big/1.png'])
  })
})
