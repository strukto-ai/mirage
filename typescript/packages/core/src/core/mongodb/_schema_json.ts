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
import { getValidator, isView, listCollections, listIndexes } from './client.ts'
import { sampleFieldTypes, type SampledField } from './_sampler.ts'
import { EntityKind, IndexType, PRIMARY_KEY } from './types.ts'

function indexType(idx: Record<string, unknown>): string {
  if ('textIndexVersion' in idx) return IndexType.TEXT
  return IndexType.BTREE
}

interface DatabaseJsonCollection {
  name: string
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
  const names = await listCollections(accessor, database)
  const viewNames = new Set(await listCollections(accessor, database, EntityKind.VIEW))
  const collections = names.filter((name) => !viewNames.has(name)).map((name) => ({ name }))
  const views = [...viewNames].map((name) => ({ name }))
  return { database, collections, views }
}

interface CollectionSchemaIndex {
  name: string | undefined
  keys: Record<string, unknown>
  type: string
}

export interface CollectionSchemaJson {
  database: string
  name: string
  kind: EntityKind
  validator: unknown
  fields: SampledField[]
  primary_key: string
  indexes: CollectionSchemaIndex[]
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
  let enrichedIndexes: CollectionSchemaIndex[] = []
  if (!view) {
    const indexes = await listIndexes(accessor, database, collection)
    enrichedIndexes = indexes.map((idx) => ({
      name: idx.name as string | undefined,
      keys: (idx.key as Record<string, unknown> | undefined) ?? {},
      type: indexType(idx),
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
    sampled: sampleSize,
  }
}
