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
import {
  countDocuments,
  getIndexStats,
  getValidator,
  isView,
  listCollections,
  listIndexes,
} from './_client.ts'
import { sampleFieldTypes, type SampledField } from './_sampler.ts'
import { EntityKind, IndexType, PRIMARY_KEY } from './types.ts'

function indexType(idx: Record<string, unknown>): string {
  if ('textIndexVersion' in idx) return IndexType.TEXT
  return IndexType.BTREE
}

interface DatabaseJsonCollection {
  name: string
  document_count: number
}

interface DatabaseJsonView {
  name: string
}

export interface DatabaseJson {
  database: string
  collections: DatabaseJsonCollection[]
  views: DatabaseJsonView[]
}

export async function buildDatabaseJson(
  accessor: MongoDBAccessor,
  database: string,
): Promise<DatabaseJson> {
  const allNames = await listCollections(accessor, database)
  const collections: DatabaseJsonCollection[] = []
  const views: DatabaseJsonView[] = []
  for (const name of allNames) {
    if (await isView(accessor, database, name)) {
      views.push({ name })
    } else {
      const doc_count = await countDocuments(accessor, database, name)
      collections.push({ name, document_count: doc_count })
    }
  }
  return { database, collections, views }
}

interface CollectionSchemaIndex {
  name: string | undefined
  keys: Record<string, unknown>
  type: string
  stats: Record<string, unknown>
}

export interface CollectionSchemaJson {
  database: string
  name: string
  kind: EntityKind
  validator: unknown
  fields: SampledField[]
  primary_key: string
  indexes: CollectionSchemaIndex[]
  document_count: number
  sampled: number
}

export async function buildCollectionSchemaJson(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  sampleSize = 100,
): Promise<CollectionSchemaJson> {
  const view = await isView(accessor, database, collection)
  const validator = await getValidator(accessor, database, collection)
  const fields = await sampleFieldTypes(accessor, database, collection, sampleSize)
  const docCount = await countDocuments(accessor, database, collection)
  let enrichedIndexes: CollectionSchemaIndex[] = []
  if (!view) {
    const indexes = await listIndexes(accessor, database, collection)
    const stats = await getIndexStats(accessor, database, collection)
    enrichedIndexes = indexes.map((idx) => ({
      name: idx.name as string | undefined,
      keys: (idx.key as Record<string, unknown> | undefined) ?? {},
      type: indexType(idx),
      stats: (stats[idx.name as string] as Record<string, unknown> | undefined) ?? {},
    }))
  }
  return {
    database,
    name: collection,
    kind: view ? EntityKind.VIEW : EntityKind.COLLECTION,
    validator,
    fields,
    primary_key: PRIMARY_KEY,
    indexes: enrichedIndexes,
    document_count: docCount,
    sampled: sampleSize,
  }
}
