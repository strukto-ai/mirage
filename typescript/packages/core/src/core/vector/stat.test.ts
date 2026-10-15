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

import { Accessor } from '../../accessor/base.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { Codec, PATH_SAFE } from '../hierarchy/codec.ts'
import { makeDetectScope, type ScopeMatch } from '../hierarchy/scope.ts'
import { makeRead } from './read.ts'
import { blobLeaf, filtersOf, rowScopes } from './scope.ts'
import { makeStat } from './stat.ts'
import type { VectorTree } from './types.ts'

class Stub extends Accessor {
  reads = 0
}

const DETECT = makeDetectScope(
  rowScopes(
    false,
    [PATH_SAFE],
    [['row_text', new Codec({ suffix: '.txt' }), ContentType.TEXT], blobLeaf('png')],
  ),
)

function children(_accessor: Stub, match: ScopeMatch): Promise<FileStat[]> {
  const label = filtersOf(['label'], match).label
  if (label === undefined) {
    return Promise.resolve([new FileStat({ name: 'cat', type: FileType.DIRECTORY })])
  }
  const row = new FileStat({ name: '1.txt', type: FileType.FILE })
  return Promise.resolve(label === 'cat' ? [row] : [])
}

const TREE: VectorTree<Stub> = {
  detect: () => DETECT,
  pinned: () => null,
  searchLimit: () => 10,
  listTables: () => Promise.resolve(['animals']),
  tableExists: (_accessor, table) => Promise.resolve(table === 'animals'),
  children,
  readers: {
    row_text: (accessor, match) => {
      accessor.reads += 1
      return Promise.resolve(new TextEncoder().encode(`row ${match.slots.row_id ?? ''}\n`))
    },
    row_blob: () => Promise.resolve(new TextEncoder().encode('PNG')),
  },
  searchRows: () => Promise.resolve([]),
  rankKey: '_score',
  drops: (rank, threshold) => rank < threshold,
  hit: () => [[], new Uint8Array()],
}

const stat = makeStat(TREE, makeRead(TREE))

function ps(path: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(path), virtual: path, directory: path })
}

describe('vector stat', () => {
  it('answers a group of an existing table as a directory', async () => {
    const s = await stat(new Stub(), ps('/animals/cat'))
    expect([s.type, s.name]).toEqual([FileType.DIRECTORY, 'cat'])
  })

  it.each(['/zoo/cat', '/zoo/cat/1.txt', '/animals/cat/1.weird/x'])(
    'answers %s as absent',
    async (path) => {
      await expect(stat(new Stub(), ps(path))).rejects.toHaveProperty('code', 'ENOENT')
    },
  )

  it('sizes a row by its read', async () => {
    // A row a listing names is answered by the mount from that listing; one
    // it does not reaches here and is rendered, so the size is exact.
    const accessor = new Stub()
    const s = await stat(accessor, ps('/animals/cat/1.txt'))
    expect([s.size, s.content, accessor.reads]).toEqual(['row 1\n'.length, ContentType.TEXT, 1])
  })

  it('types a leaf by its scope', async () => {
    const s = await stat(new Stub(), ps('/animals/cat/1.png'))
    expect([s.type, s.content, s.size]).toEqual([FileType.FILE, ContentType.IMAGE_PNG, 3])
  })
})
