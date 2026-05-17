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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { findDocuments, listCollections, listIndexes } from './_client.ts'
import { stringifyDoc } from './stream.ts'
import { EntityKind, PRIMARY_KEY } from './types.ts'

export interface CollectionMatches {
  database: string
  collection: string
  docs: Record<string, unknown>[]
}

function collectStringPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = prefix === '' ? k : `${prefix}.${k}`
      collectStringPaths(v, sub, out)
    }
    return
  }
  if (typeof value === 'string' && prefix !== '' && prefix !== PRIMARY_KEY) {
    out.add(prefix)
  }
}

async function sampledStringPaths(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  sampleSize = 100,
): Promise<string[]> {
  const paths = new Set<string>()
  let n = 0
  for await (const doc of accessor.driver.iterDocuments(database, collection, {
    batchSize: sampleSize,
  })) {
    collectStringPaths(doc, '', paths)
    n++
    if (n >= sampleSize) break
  }
  return [...paths].sort()
}

export async function searchCollection(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  pattern: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const indexes = await listIndexes(accessor, database, collection)
  const hasTextIndex = indexes.some((idx) => 'textIndexVersion' in idx)
  if (hasTextIndex) {
    return findDocuments(accessor, database, collection, { $text: { $search: pattern } }, { limit })
  }
  const paths = await sampledStringPaths(accessor, database, collection)
  if (paths.length === 0) return []
  const orFilters = paths.map((f) => ({ [f]: { $regex: pattern, $options: 'i' } }))
  return findDocuments(accessor, database, collection, { $or: orFilters }, { limit })
}

export async function searchDatabase(
  accessor: MongoDBAccessor,
  database: string,
  pattern: string,
  limit: number,
): Promise<CollectionMatches[]> {
  const collections = await listCollections(accessor, database, EntityKind.COLLECTION)
  const tasks = collections.map((col) =>
    searchCollection(accessor, database, col, pattern, limit).then((docs) => [col, docs] as const),
  )
  const settled = await Promise.all(tasks)
  const out: CollectionMatches[] = []
  for (const [col, docs] of settled) {
    if (docs.length > 0) out.push({ database, collection: col, docs })
  }
  return out
}

export function formatGrepResults(results: readonly CollectionMatches[]): string[] {
  const lines: string[] = []
  for (const { database, collection, docs } of results) {
    const path = `${database}/collections/${collection}/documents.jsonl`
    for (const doc of docs) {
      lines.push(`${path}:${stringifyDoc(doc)}`)
    }
  }
  return lines
}
