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
import { ensureDirSizes } from './sizes.ts'

interface Chunk {
  document: string
  metadata: Record<string, unknown>
}

class FakeCollection {
  readonly calls: unknown[] = []

  constructor(readonly chunks: Record<string, Chunk[]>) {}

  get(args: {
    where?: Record<string, unknown>
    include?: string[]
    limit?: number
    offset?: number
  }): Promise<{ documents: (string | null)[]; metadatas: (Record<string, unknown> | null)[] }> {
    this.calls.push(args)
    const selector = args.where?.page_slug as { $in?: string[] } | undefined
    const slugs = selector?.$in ?? []
    const flat = slugs.flatMap((slug) => this.chunks[slug] ?? [])
    return Promise.resolve({
      documents: flat.map((c) => c.document),
      metadatas: flat.map((c) => c.metadata),
    })
  }
}

function fakeAccessor(collection: FakeCollection): ChromaAccessor {
  return {
    config: { slugField: 'page_slug', chunkIndexField: 'chunk_index' },
    getCollection: () => Promise.resolve(collection),
  } as unknown as ChromaAccessor
}

function fileEntry(name: string, slug: string): IndexEntry {
  return new IndexEntry({
    id: slug,
    name,
    resourceType: 'file',
    vfsName: name,
    extra: { slug, source_size: 999 },
  })
}

const CHUNKS: Record<string, Chunk[]> = {
  'guides/quickstart': [
    { document: 'second', metadata: { page_slug: 'guides/quickstart', chunk_index: 2 } },
    { document: 'first', metadata: { page_slug: 'guides/quickstart', chunk_index: 1 } },
  ],
  'guides/auth': [{ document: 'auth', metadata: { page_slug: 'guides/auth', chunk_index: 0 } }],
}

describe('chroma ensureDirSizes', () => {
  it('sizes every unsized file in the directory with one scan', async () => {
    const collection = new FakeCollection(CHUNKS)
    const index = new RAMIndexCacheStore()
    await index.setDir('/knowledge/guides', [
      ['quickstart', fileEntry('quickstart', 'guides/quickstart')],
      ['auth', fileEntry('auth', 'guides/auth')],
    ])

    await ensureDirSizes(fakeAccessor(collection), '/knowledge/guides', index)

    // "first\nsecond": chunk order comes from chunk_index, not the scan order.
    expect((await index.get('/knowledge/guides/quickstart')).entry?.size).toBe(12)
    expect((await index.get('/knowledge/guides/auth')).entry?.size).toBe(4)
    expect(collection.calls).toHaveLength(1)
  })

  it('does not rescan once every file is sized', async () => {
    const collection = new FakeCollection(CHUNKS)
    const index = new RAMIndexCacheStore()
    await index.setDir('/knowledge/guides', [
      ['auth', fileEntry('auth', 'guides/auth')],
    ])

    await ensureDirSizes(fakeAccessor(collection), '/knowledge/guides', index)
    await ensureDirSizes(fakeAccessor(collection), '/knowledge/guides', index)

    expect(collection.calls).toHaveLength(1)
  })

  it('leaves a page with no chunks unsized', async () => {
    const collection = new FakeCollection({})
    const index = new RAMIndexCacheStore()
    await index.setDir('/knowledge/guides', [
      ['gone', fileEntry('gone', 'guides/gone')],
    ])

    await ensureDirSizes(fakeAccessor(collection), '/knowledge/guides', index)

    expect((await index.get('/knowledge/guides/gone')).entry?.size).toBeNull()
  })
})
