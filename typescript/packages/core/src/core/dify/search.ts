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
import type { DifyAccessor } from '../../accessor/dify.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { formatScore } from '../../utils/score.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { difyPost } from './_client.ts'
import { resolvePath } from './path.ts'
import { segmentText } from './read.ts'
import { normalizeSlug, scalarString } from './tree.ts'
import { walk } from './walk.ts'

const ENC = new TextEncoder()

const METHODS: Record<string, string> = {
  semantic: 'semantic_search',
  fulltext: 'full_text_search',
  hybrid: 'hybrid_search',
  keyword: 'keyword_search',
}

export interface SearchOptions {
  method?: string
  topK?: number
  threshold?: number
  mountPrefix?: string
}

export async function searchSegments(
  accessor: DifyAccessor,
  query: string,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
  options: SearchOptions = {},
): Promise<Uint8Array> {
  const method = options.method ?? 'semantic'
  const topK = options.topK ?? 10
  const threshold = options.threshold ?? 0
  const searchMethod = validateArgs(query, method, topK, threshold)
  let mountPrefix = options.mountPrefix ?? ''
  if (mountPrefix === '' && paths.length > 0 && paths[0] !== undefined) {
    mountPrefix = mountPrefixOf(paths[0].virtual, paths[0].resourcePath)
  }
  const retrievalModel: Record<string, unknown> = {
    search_method: searchMethod,
    top_k: Math.min(topK, 100),
    score_threshold_enabled: threshold > 0,
    score_threshold: threshold,
    reranking_enable: false,
  }
  if (paths.length > 0) {
    const conditions = await metadataConditions(accessor, paths, index)
    if (conditions.length === 0) return new Uint8Array(0)
    retrievalModel.metadata_filtering_conditions = { logical_operator: 'or', conditions }
  }
  const response = await difyPost(accessor, `/datasets/${accessor.config.datasetId}/retrieve`, {
    query,
    retrieval_model: retrievalModel,
  })
  return recordsToBytes(
    responseRecords(response.records),
    accessor.config.slugMetadataName,
    mountPrefix,
  )
}

function validateArgs(query: string, method: string, topK: number, threshold: number): string {
  if (query === '') throw new Error('search: query is required')
  if (query.length > 250) throw new Error('search: query cannot exceed 250 characters')
  if (topK <= 0) throw new Error('search: top-k must be positive')
  if (threshold < 0 || threshold > 1) throw new Error('search: threshold must be in [0, 1]')
  const searchMethod = METHODS[method]
  if (searchMethod === undefined) {
    throw new Error('search: method must be one of semantic, fulltext, hybrid, keyword')
  }
  return searchMethod
}

async function metadataConditions(
  accessor: DifyAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<Record<string, unknown>[]> {
  const targets = await targetEntries(accessor, paths, index)
  const slugValues: string[] = []
  const nameValues: string[] = []
  for (const entry of targets.values()) {
    if (entry.extra.has_slug === true) {
      slugValues.push(String(entry.extra.raw_slug))
    } else {
      nameValues.push(entry.name)
    }
  }
  const conditions: Record<string, unknown>[] = []
  if (slugValues.length > 0) {
    conditions.push({
      name: accessor.config.slugMetadataName,
      comparison_operator: 'in',
      value: [...slugValues].sort(),
    })
  }
  if (nameValues.length > 0) {
    conditions.push({
      name: 'document_name',
      comparison_operator: 'in',
      value: [...nameValues].sort(),
    })
  }
  return conditions
}

async function targetEntries(
  accessor: DifyAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<Map<string, IndexEntry>> {
  const targets = new Map<string, IndexEntry>()
  for (const path of paths) {
    const resolved = await resolvePath(accessor, path, index)
    if (resolved.entry !== null && !resolved.isDir) {
      targets.set(resolved.entry.id, resolved.entry)
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
          targets.set(childResolved.entry.id, childResolved.entry)
        }
      }
    }
  }
  return targets
}

function responseRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Dify search response records must be a list')
  }
  const records: Record<string, unknown>[] = []
  for (const record of value) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Dify search response records must be objects')
    }
    records.push(record as Record<string, unknown>)
  }
  return records
}

function recordsToBytes(
  records: Record<string, unknown>[],
  slugMetadataName: string,
  mountPrefix: string,
): Uint8Array {
  const contents: string[] = []
  for (const record of records) {
    const segment = record.segment
    if (segment === null || typeof segment !== 'object' || Array.isArray(segment)) continue
    const header = formatRecordHeader(record, slugMetadataName, mountPrefix)
    if (header === null) continue
    contents.push(`${header}\n${segmentText(segment as Record<string, unknown>)}`)
  }
  if (contents.length === 0) return new Uint8Array(0)
  return ENC.encode(contents.join('\n') + '\n')
}

function formatRecordHeader(
  record: Record<string, unknown>,
  slugMetadataName: string,
  mountPrefix: string,
): string | null {
  const path = recordPath(record, slugMetadataName, mountPrefix)
  if (path === null) return null
  const score = formatScore(record.score)
  if (score === null) return path
  return `${path}:${score}`
}

function recordPath(
  record: Record<string, unknown>,
  slugMetadataName: string,
  mountPrefix: string,
): string | null {
  const segment = record.segment
  if (segment === null || typeof segment !== 'object' || Array.isArray(segment)) return null
  const document = (segment as Record<string, unknown>).document
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null
  const rawPath = documentPath(document as Record<string, unknown>, slugMetadataName)
  if (rawPath === null) return null
  let normalized: string
  try {
    normalized = normalizeSlug(rawPath)
  } catch {
    return null
  }
  const prefix = rstripSlash(mountPrefix)
  return prefix !== '' ? prefix + normalized : normalized
}

function documentPath(document: Record<string, unknown>, slugMetadataName: string): string | null {
  const metadata = document.doc_metadata
  if (Array.isArray(metadata)) {
    for (const item of metadata) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>
        if (record.name === slugMetadataName) {
          const value = scalarString(record.value)
          if (value !== null) return value
        }
      }
    }
  }
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = scalarString((metadata as Record<string, unknown>)[slugMetadataName])
    if (value !== null) return value
  }
  return scalarString(document.name)
}
