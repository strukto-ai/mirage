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

import type { QdrantPoint } from './types.ts'
import type { QdrantClient } from '@qdrant/js-client-rest'
import { expect, it, vi } from 'vitest'

import { QdrantAccessor } from '../../accessor/qdrant.ts'
import { ioFor } from '../../test-utils.ts'
import { QdrantVFS } from '../../vfs/qdrant/qdrant.ts'
import { searchResources } from '../../vfs/search.ts'
import { resolveQdrantConfig, type QdrantConfig } from '../../vfs/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { searchRowsOutput } from '../vector/search.ts'

import { TREE } from './tree.ts'

function accessorOf(config: QdrantConfig, points: QdrantPoint[]) {
  const query = vi.fn((_collection: string, _opts: { limit: number }) =>
    Promise.resolve({ points }),
  )
  const accessor = new QdrantAccessor(resolveQdrantConfig({ cloudInference: true, ...config }))
  vi.spyOn(accessor, 'client').mockResolvedValue({ query } as unknown as QdrantClient)
  return { accessor, query }
}

it('returns the canonical nested document lineage path', async () => {
  const { accessor } = accessorOf(
    {
      collection: 'docs',
      groupBy: ['metadata.source'],
      basenameFields: ['metadata.source'],
      nameField: 'metadata.page',
      textField: 'page_content',
    },
    [
      {
        id: 17,
        score: 0.81,
        payload: {
          page_content: 'Refunds are processed within 14 days',
          metadata: { source: 's3://docs/refund.pdf', page: '004' },
        },
      },
    ],
  )
  const path = new PathSpec({ virtual: '/db', directory: '/db', vfsPath: '' })
  const output = new TextDecoder().decode(
    await searchRowsOutput(TREE, accessor, 'refund', [path], 1, 0, '/db'),
  )
  expect(output).toBe('/db/refund.pdf/004__17.txt:0.8100\nRefunds are processed within 14 days\n')
})

it('uses one native ranking for a batch and carries the requested limit', async () => {
  const { accessor, query } = accessorOf({ collection: 'docs', textField: 'text' }, [
    { id: 17, score: 0.81, payload: { text: 'answer' } },
  ])
  const root = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })
  const result = await searchResources(ioFor(QdrantVFS, accessor).search, accessor, [root, root], {
    query: 'question',
    options: { top_k: 2, threshold: 0.5 },
  })
  expect(new TextDecoder().decode(result)).toBe('/data/17.txt:0.8100\nanswer\n')
  expect(query).toHaveBeenCalledOnce()
  expect(query.mock.calls[0]?.[1]).toMatchObject({ limit: 2 })
})
