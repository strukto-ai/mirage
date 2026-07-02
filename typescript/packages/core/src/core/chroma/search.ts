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

import { mountPrefixOf, rekey } from '../../utils/key_prefix.ts'
import type { Where } from 'chromadb'
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { scoreFromDistance } from '../../utils/score.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { metadataString } from './_client.ts'
import { resolvePath } from './path.ts'
import { walk } from './walk.ts'

const ENC = new TextEncoder()

export async function searchSegments(
  accessor: ChromaAccessor,
  query: string,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
  topK = 10,
  mountPrefix = '',
): Promise<Uint8Array> {
  validateArgs(query, topK)
  if (mountPrefix === '' && paths.length > 0) {
    mountPrefix =
      (paths[0] === undefined
        ? undefined
        : mountPrefixOf(paths[0].virtual, paths[0].resourcePath)) ?? ''
  }
  let scopedSlugs: Set<string> | null = null
  let where: Where | undefined
  if (paths.length > 0) {
    scopedSlugs = new Set((await targetEntries(accessor, paths, index)).keys())
    if (scopedSlugs.size === 0) return new Uint8Array(0)
    where = { [accessor.config.slugField]: { $in: [...scopedSlugs].sort() } } as Where
  }
  const collection = await accessor.getCollection()
  const response = await collection.query({
    queryTexts: [query],
    nResults: topK,
    include: ['documents', 'metadatas', 'distances'],
    ...(where !== undefined ? { where } : {}),
  })
  return queryResultToBytes(response, accessor.config.slugField, mountPrefix, scopedSlugs)
}

export function validateArgs(query: string, topK: number): void {
  if (query === '') {
    throw new Error('search: query is required')
  }
  if (query.length > 250) {
    throw new Error('search: query cannot exceed 250 characters')
  }
  if (topK <= 0) {
    throw new Error('search: top-k must be positive')
  }
}

export async function targetEntries(
  accessor: ChromaAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<Map<string, IndexEntry>> {
  const targets = new Map<string, IndexEntry>()
  for (const path of paths) {
    const resolved = await resolvePath(accessor, path, index)
    if (resolved.entry !== null && !resolved.isDir) {
      targets.set(String(resolved.entry.extra.slug), resolved.entry)
      continue
    }
    if (resolved.isDir) {
      const children = await walk(accessor, path, index, {
        includeRoot: false,
        stripPrefix: false,
      })
      for (const child of children) {
        const childSpec = PathSpec.fromStrPath(child, rekey(path.virtual, path.resourcePath, child))
        const childResolved = await resolvePath(accessor, childSpec, index)
        if (childResolved.entry !== null && !childResolved.isDir) {
          targets.set(String(childResolved.entry.extra.slug), childResolved.entry)
        }
      }
    }
  }
  return targets
}

export interface ChromaQueryResponse {
  documents?: unknown
  metadatas?: unknown
  distances?: unknown
}

export function queryResultToBytes(
  response: ChromaQueryResponse,
  slugField: string,
  mountPrefix: string,
  scopedSlugs: ReadonlySet<string> | null = null,
): Uint8Array {
  const documents = firstResultList(response.documents)
  const metadatas = firstResultList(response.metadatas)
  const distances = firstResultList(response.distances)
  const contents: string[] = []
  for (let i = 0; i < documents.length; i++) {
    const document = documents[i]
    const metadata = metadatas[i]
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    const slug = metadataString((metadata as Record<string, unknown>)[slugField])
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
  if (contents.length === 0) return new Uint8Array(0)
  return ENC.encode(contents.join('\n') + '\n')
}

export function firstResultList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  if (value.length > 0 && Array.isArray(value[0])) return value[0] as unknown[]
  return value
}
