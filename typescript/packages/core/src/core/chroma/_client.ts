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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import { enoent } from '../../utils/errors.ts'

const PATH_TREE_ID = '__path_tree__'
const PAGE_CHUNK_BATCH_SIZE = 100

interface ChromaChunk {
  document: string
  metadata: Record<string, unknown>
}

export function metadataString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export async function fetchPathTree(accessor: ChromaAccessor): Promise<string> {
  const collection = await accessor.getCollection()
  const result = await collection.get({ ids: [PATH_TREE_ID] })
  const value = result.documents[0]
  if (value === undefined || value === null) throw enoent(PATH_TREE_ID)
  return value
}

export async function fetchPageChunks(accessor: ChromaAccessor, slug: string): Promise<string> {
  const chunks = await pageChunks(accessor, slug)
  return chunks.map((chunk) => chunk.document).join('\n')
}

export async function* iterPageChunks(
  accessor: ChromaAccessor,
  slug: string,
): AsyncIterable<string> {
  const chunks = await pageChunks(accessor, slug)
  for (const chunk of chunks) {
    yield chunk.document
  }
}

async function pageChunks(accessor: ChromaAccessor, slug: string): Promise<ChromaChunk[]> {
  const collection = await accessor.getCollection()
  const field = accessor.config.chunkIndexField
  const chunks: ChromaChunk[] = []
  let offset = 0
  for (;;) {
    const result = await collection.get({
      where: { [accessor.config.slugField]: slug },
      include: ['documents', 'metadatas'],
      limit: PAGE_CHUNK_BATCH_SIZE,
      offset,
    })
    const documents = result.documents
    const metadatas = result.metadatas
    for (let i = 0; i < documents.length; i++) {
      chunks.push({
        document: documents[i] ?? '',
        metadata: metadatas[i] ?? {},
      })
    }
    if (documents.length < PAGE_CHUNK_BATCH_SIZE) break
    offset += PAGE_CHUNK_BATCH_SIZE
  }
  return chunks.sort((a, b) => chunkIndex(a.metadata, field) - chunkIndex(b.metadata, field))
}

function chunkIndex(metadata: Record<string, unknown>, field: string): number {
  const value = metadata[field] ?? 0
  if (typeof value === 'boolean') return 0
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  return 0
}
