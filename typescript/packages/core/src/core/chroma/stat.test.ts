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
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { stat } from './stat.ts'

const QUICKSTART = '/knowledge/guides/quickstart'

function accessorCounting(calls: unknown[]): ChromaAccessor {
  const collection = {
    get: (args: unknown) => {
      calls.push(args)
      return Promise.resolve({
        documents: ['first'],
        metadatas: [{ page_slug: 'guides/quickstart', chunk_index: 0 }],
      })
    },
  }
  return {
    config: { slugField: 'page_slug', chunkIndexField: 'chunk_index' },
    getCollection: () => Promise.resolve(collection),
  } as unknown as ChromaAccessor
}

async function seededIndex(): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await index.setDir('/knowledge', [
    ['guides', new IndexEntry({ id: 'guides', name: 'guides', resourceType: 'folder' })],
  ])
  await index.setDir('/knowledge/guides', [
    [
      'quickstart',
      new IndexEntry({
        id: 'guides/quickstart',
        name: 'quickstart',
        resourceType: 'file',
        extra: { slug: 'guides/quickstart' },
      }),
    ],
  ])
  return index
}

const path = new PathSpec({
  vfsPath: mountKey(QUICKSTART, '/knowledge'),
  virtual: QUICKSTART,
  directory: QUICKSTART,
})

describe('chroma stat', () => {
  it('stat sizes the rendered page with one scan', async () => {
    const calls: unknown[] = []
    const result = await stat(accessorCounting(calls), path, await seededIndex())
    expect(result.size).toBe(5)
    expect(calls).toHaveLength(1)
  })
})
