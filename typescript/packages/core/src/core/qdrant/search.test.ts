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

import { expect, it } from 'vitest'

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { resolveQdrantConfig } from '../../resource/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { searchRowsOutput } from './search.ts'

it('returns the canonical nested document lineage path', async () => {
  const config = resolveQdrantConfig({
    collection: 'docs',
    groupBy: ['metadata.source'],
    basenameFields: ['metadata.source'],
    nameField: 'metadata.page',
    textField: 'page_content',
  })
  const accessor = {
    config,
    searchRows: () =>
      Promise.resolve([
        {
          id: 17,
          _score: 0.81,
          page_content: 'Refunds are processed within 14 days',
          metadata: { source: 's3://docs/refund.pdf', page: '004' },
        },
      ]),
  } as unknown as QdrantAccessor
  const path = new PathSpec({ virtual: '/db', directory: '/db', resourcePath: '' })
  const output = new TextDecoder().decode(
    await searchRowsOutput(accessor, 'refund', [path], 1, 0, '/db'),
  )

  expect(output).toMatch(/^\/db\/refund\.pdf\/004__17\.txt:0\.8100\n/)
})
