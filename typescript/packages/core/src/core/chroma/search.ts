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

import type { Where } from 'chromadb'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { mountPrefixOf, mountedPath } from '../../utils/key_prefix.ts'
import { scoreFromDistance } from '../../utils/score.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { intOption, validateOptions } from '../../vfs/search.ts'
import type { SearchQuery } from '../../vfs/types.ts'
import { scalarString } from '../slug_tree/rows.ts'
import { searchScope, targetEntries, validateQuery } from '../slug_tree/search.ts'
import { PAGE_CHUNK_BATCH_SIZE } from './client.ts'
import { CHROMA_TREE } from './tree.ts'

export async function searchSegments(
  accessor: ChromaAccessor,
  query: string,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
  topK = 10,
  mountPrefix = '',
): Promise<string[]> {
  validateQuery(query, topK)
  if (mountPrefix === '' && paths.length > 0) {
    mountPrefix =
      (paths[0] === undefined ? undefined : mountPrefixOf(paths[0].virtual, paths[0].vfsPath)) ?? ''
  }
  let scopedSlugs: Set<string> | null = null
  let where: Where | undefined
  if (paths.length > 0) {
    scopedSlugs = new Set((await targetEntries(CHROMA_TREE, accessor, paths, index)).keys())
    if (scopedSlugs.size === 0) return []
    where = {
      [accessor.config.slugField]: { $in: [...scopedSlugs].sort(compareCodePoints) },
    } as Where
  }
  const collection = await accessor.getCollection()
  const response = await collection.query({
    queryTexts: [query],
    nResults: topK,
    include: ['documents', 'metadatas', 'distances'],
    ...(where !== undefined ? { where } : {}),
  })
  return renderRecords(response, accessor.config.slugField, mountPrefix, scopedSlugs)
}

interface ChromaQueryResponse {
  documents?: unknown
  metadatas?: unknown
  distances?: unknown
}

function renderRecords(
  response: ChromaQueryResponse,
  slugField: string,
  mountPrefix: string,
  scopedSlugs: ReadonlySet<string> | null = null,
): string[] {
  const documents = firstResultList(response.documents)
  const metadatas = firstResultList(response.metadatas)
  const distances = firstResultList(response.distances)
  const contents: string[] = []
  for (let i = 0; i < documents.length; i++) {
    const document = documents[i]
    const metadata = metadatas[i]
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    const slug = scalarString((metadata as Record<string, unknown>)[slugField])
    if (slug === null) continue
    const slugValue = stripSlash(slug)
    if (scopedSlugs !== null && !scopedSlugs.has(slugValue)) continue
    const score = scoreFromDistance(distances[i])
    let path = '/' + slugValue
    const prefix = rstripSlash(mountPrefix)
    if (prefix !== '') path = prefix + path
    const content = typeof document === 'string' ? document : ''
    contents.push(`${path}:${score}\n${content}`)
  }
  return contents
}

function firstResultList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  if (value.length > 0 && Array.isArray(value[0])) return value[0] as unknown[]
  return value
}

export async function searchMany(
  accessor: ChromaAccessor,
  paths: PathSpec[],
  query: SearchQuery,
  index?: IndexCacheStore,
): Promise<string[]> {
  validateOptions(query, ['top_k'])
  const topK = intOption(query, 'top_k', 10)
  const [targets, prefix] = await searchScope(CHROMA_TREE, accessor, paths, index)
  return searchSegments(accessor, query.query, targets, index, topK, prefix)
}

export function searchResource(
  accessor: ChromaAccessor,
  path: PathSpec,
  query: SearchQuery,
  index?: IndexCacheStore,
): Promise<string[]> {
  return searchMany(accessor, [path], query, index)
}

/**
 * The pages with a chunk holding `text`.
 *
 * A page is its chunks joined by line breaks, so a line, and so any match
 * grep makes, lies within one chunk, and Chroma's `$contains` over the chunks
 * answers exactly. It matches case, so -i reads every page. Below the mount's
 * root only the walked pages are asked. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: ChromaAccessor,
  text: string,
  under: readonly PathSpec[],
  ignoreCase: boolean,
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const [first] = under
  if (ignoreCase || first === undefined) return null
  const field = accessor.config.slugField
  let where: Where | undefined
  if (under.every((scope) => stripSlash(scope.mountPath) !== '')) {
    const walked = await targetEntries(CHROMA_TREE, accessor, under, index)
    if (walked.size === 0) return []
    where = { [field]: { $in: [...walked.keys()].sort(compareCodePoints) } } as Where
  }
  const collection = await accessor.getCollection()
  const slugs = new Set<string>()
  for (let offset = 0; ; offset += PAGE_CHUNK_BATCH_SIZE) {
    const result = await collection.get({
      ...(where !== undefined ? { where } : {}),
      whereDocument: { $contains: text },
      include: ['metadatas'],
      limit: PAGE_CHUNK_BATCH_SIZE,
      offset,
    })
    for (const metadata of result.metadatas) {
      const slug = scalarString(metadata?.[field])
      if (slug !== null) slugs.add(stripSlash(slug))
    }
    if (result.ids.length < PAGE_CHUNK_BATCH_SIZE) break
  }
  return [...slugs].sort(compareCodePoints).map((slug) => mountedPath(first, `/${slug}`))
}
