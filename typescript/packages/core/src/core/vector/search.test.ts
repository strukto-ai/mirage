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
import { PathSpec } from '../../types.ts'
import { makeSearch, searchRowsOutput } from './search.ts'
import type { Row, VectorTree } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const ROWS: Row[] = [
  { id: '1', label: 'cat', _score: 0.9, _distance: 0.9 },
  { id: '2', label: 'dog', _score: 0.2, _distance: 0.2 },
]

function tree(
  pinned: string | null = null,
  rankKey = '_score',
  drops = (rank: number, threshold: number) => rank < threshold,
): VectorTree<Accessor> {
  return {
    vfs: 'stub',
    detect: () => {
      throw new Error('unused')
    },
    pinned: () => pinned,
    searchLimit: () => 10,
    listTables: () => Promise.resolve(['animals']),
    tableExists: () => Promise.resolve(true),
    children: () => Promise.resolve([]),
    readers: {},
    searchRows: (_accessor, _table, _query, limit) => Promise.resolve(ROWS.slice(0, limit)),
    rankKey,
    drops,
    hit: (_accessor, row) => [
      [String(row.label), `${String(row.id)}.txt`],
      ENC.encode(`${String(row.label)}\n`),
    ],
  }
}

function ps(path: string): PathSpec {
  return new PathSpec({ vfsPath: path.replace(/^\/db\/?/, ''), virtual: path, directory: path })
}

async function headers(t: VectorTree<Accessor>, path: string, topK = 10, threshold = 0) {
  const out = await searchRowsOutput(t, new Accessor(), 'q', [ps(path)], topK, threshold, '/db')
  return DEC.decode(out)
    .split('\n')
    .filter((line) => line.includes(':'))
}

describe('vector search', () => {
  it('spells a hit under its table with its rank', async () => {
    const out = await searchRowsOutput(
      tree(),
      new Accessor(),
      'q',
      [ps('/db/animals')],
      1,
      0,
      '/db',
    )
    expect(DEC.decode(out)).toBe('/db/animals/cat/1.txt:0.9000\ncat\n')
  })

  it('leaves a pinned table out of the path', async () => {
    expect(await headers(tree('animals'), '/db', 1)).toEqual(['/db/cat/1.txt:0.9000'])
  })

  it.each([
    ['_score', (rank: number, t: number) => rank < t, '/db/animals/cat/1.txt:0.9000'],
    ['_distance', (rank: number, t: number) => rank > t, '/db/animals/dog/2.txt:0.2000'],
  ])('drops %s ranks in the store direction', async (rankKey, drops, kept) => {
    expect(await headers(tree(null, rankKey, drops), '/db/animals', 10, 0.5)).toEqual([kept])
  })

  it.each([
    ['', 2, '/db/animals', 'search: query is required'],
    ['q', 0, '/db/animals', 'search: top-k must be positive'],
    ['q', 2, '/db', 'search: no table to search'],
  ])('refuses %j top %i at %s', async (query, topK, path, message) => {
    await expect(
      searchRowsOutput(tree(), new Accessor(), query, [ps(path)], topK, 0, '/db'),
    ).rejects.toThrow(message)
  })

  it('searches one scope as a batch of one', async () => {
    const ops = makeSearch(tree())
    await expect(
      ops.search(new Accessor(), ps('/db/animals'), { query: 'q', options: { top_k: 1 } }),
    ).resolves.toEqual(['/db/animals/cat/1.txt:0.9000', 'cat'])
  })

  it.each([
    [{ top_k: 1, rerank: true }, 'search: unknown options: rerank'],
    [{ method: 'hybrid' }, "search: only the 'semantic' method is supported"],
  ])('refuses a batch the store cannot rank: %j', async (options, message) => {
    const ops = makeSearch(tree())
    await expect(
      ops.searchMany(new Accessor(), [ps('/db/animals')], { query: 'q', options }),
    ).rejects.toThrow(message)
  })
})
