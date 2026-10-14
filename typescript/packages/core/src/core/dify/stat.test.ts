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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, listAllDocuments: vi.fn() }
})

import type { DifyAccessor } from '../../accessor/dify.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import * as clientMod from './client.ts'
import { stat } from './stat.ts'

const ACCESSOR = { config: { slugMetadataName: 'slug' } } as DifyAccessor

function document(
  documentId: string,
  name: string,
  slug: string,
  size = 123,
): Record<string, unknown> {
  return {
    id: documentId,
    name,
    doc_metadata: [{ name: 'slug', value: slug }],
    enabled: true,
    indexing_status: 'completed',
    archived: false,
    tokens: 9,
    data_source_type: 'upload_file',
    data_source_detail_dict: { upload_file: { size } },
    created_at: 1716282000,
  }
}

function pathAt(virtual: string): PathSpec {
  return new PathSpec({
    vfsPath: mountKey(virtual, '/knowledge'),
    virtual,
    directory: virtual,
  })
}

// Mirrors test_stat.py.
describe('dify stat', () => {
  beforeEach(() => {
    vi.mocked(clientMod.listAllDocuments).mockReset()
    vi.mocked(clientMod.listAllDocuments).mockResolvedValue([
      document('doc-1', 'Quickstart', 'guides/quickstart'),
    ])
  })

  it('answers from the listing', async () => {
    const index = new RAMIndexCacheStore()

    const item = await stat(ACCESSOR, pathAt('/knowledge/guides/quickstart'), index)

    expect(item.name).toBe('quickstart')
    expect(item.content).toBe(ContentType.TEXT)
    expect(item.size).toBeNull()
    expect(item.extra.document_id).toBe('doc-1')
    expect(item.extra.source_size).toBe(123)
    expect(item.modified).toBe('2024-05-21T09:00:00Z')
    expect(item.birthtime).toBe('2024-05-21T09:00:00Z')
    expect(item.extra.slug).toBe('guides/quickstart')
  })

  it('answers a directory', async () => {
    const index = new RAMIndexCacheStore()

    const item = await stat(ACCESSOR, pathAt('/knowledge/guides'), index)

    expect(item.name).toBe('guides')
    expect(item.type).toBe(FileType.DIRECTORY)
    expect(item.extra).toEqual({ children_count: 0 })
  })
})
