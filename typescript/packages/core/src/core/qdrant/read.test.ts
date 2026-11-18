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

import type { QdrantClient } from '@qdrant/js-client-rest'
import { expect, it, vi } from 'vitest'

import { QdrantAccessor } from '../../accessor/qdrant.ts'
import { QdrantConfig } from '../../vfs/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { read } from './tree.ts'

function lineageAccessor(requested: unknown[]): QdrantAccessor {
  const accessor = new QdrantAccessor(
    QdrantConfig.parse({
      collection: 'docs',
      groupBy: ['metadata.source'],
      basenameFields: ['metadata.source'],
      nameField: 'metadata.page',
      textField: 'page_content',
    }),
  )
  const client = {
    retrieve: (_collection: string, opts: { ids: unknown[] }) => {
      requested.push(...opts.ids)
      return Promise.resolve([
        {
          id: 17,
          payload: {
            page_content: 'Refunds are processed within 14 days',
            metadata: { source: 's3://docs/refund.pdf', page: '004' },
          },
        },
      ])
    },
  }
  vi.spyOn(accessor, 'client').mockResolvedValue(client as unknown as QdrantClient)
  return accessor
}

function spec(path: string): PathSpec {
  return new PathSpec({ virtual: path, directory: path, vfsPath: path.slice(1) })
}

it('reads a payload-named chunk by its embedded point id', async () => {
  const requested: unknown[] = []
  const data = await read(lineageAccessor(requested), spec('/refund.pdf/004__17.txt'))
  expect(new TextDecoder().decode(data)).toBe('Refunds are processed within 14 days\n')
  expect(requested).toEqual([17])
})

it('rejects a stem the listing never published', async () => {
  // The label is stripped before the retrieve, so any spelling that ends in
  // __<id> fetches the point; only the stem readdir publishes opens.
  for (const path of ['/refund.pdf/wrong__17.txt', '/refund.pdf/17.txt']) {
    await expect(read(lineageAccessor([]), spec(path))).rejects.toHaveProperty('code', 'ENOENT')
  }
})
