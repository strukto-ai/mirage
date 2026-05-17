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
import type { MongoFindOptions, MongoIndexAccess, MongoIterOptions } from './_driver.ts'
import { EntityKind } from './types.ts'

const SYSTEM_DBS: ReadonlySet<string> = new Set(['admin', 'local', 'config'])

export async function listDatabases(accessor: MongoDBAccessor): Promise<string[]> {
  return accessor.cachedList('listDatabases', async () => {
    const all = await accessor.driver.listDatabases()
    let dbs = all.filter((d) => !SYSTEM_DBS.has(d))
    const allow = accessor.config.databases
    if (allow !== null) {
      const allowSet = new Set(allow)
      dbs = dbs.filter((d) => allowSet.has(d))
    }
    return [...dbs].sort()
  })
}

export async function listCollections(
  accessor: MongoDBAccessor,
  database: string,
  kind: EntityKind | null = null,
): Promise<string[]> {
  const key = `listCollections:${database}:${kind ?? ''}`
  return accessor.cachedList(key, async () => {
    const cols = await accessor.driver.listCollections(database, kind)
    return [...cols].sort()
  })
}

export async function databaseExists(
  accessor: MongoDBAccessor,
  database: string,
): Promise<boolean> {
  const dbs = await listDatabases(accessor)
  return dbs.includes(database)
}

export async function entityExists(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
  kind: EntityKind | null = null,
): Promise<boolean> {
  if (!(await databaseExists(accessor, database))) return false
  const names = await listCollections(accessor, database, kind)
  return names.includes(name)
}

export async function findDocuments<T = Record<string, unknown>>(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  filter: Record<string, unknown> = {},
  options: MongoFindOptions = {},
): Promise<T[]> {
  const cap = accessor.config.maxDocLimit
  const requested = options.limit ?? cap
  const limit = Math.min(requested, cap)
  return accessor.driver.findDocuments<T>(database, collection, filter, {
    ...options,
    limit,
  })
}

export function iterDocuments<T = Record<string, unknown>>(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  options: MongoIterOptions = {},
): AsyncIterableIterator<T> {
  return accessor.driver.iterDocuments<T>(database, collection, options)
}

export function iterInserts<T = Record<string, unknown>>(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
): AsyncIterableIterator<T> {
  return accessor.driver.iterInserts<T>(database, collection)
}

export async function countDocuments(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<number> {
  return accessor.driver.countDocuments(database, collection, filter)
}

export async function isView(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
): Promise<boolean> {
  const specs = await accessor.driver.listCollectionsDetailed(database, {
    name: collection,
  })
  for (const spec of specs) return spec.type === EntityKind.VIEW
  return false
}

export async function listIndexes(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
): Promise<Record<string, unknown>[]> {
  if (await isView(accessor, database, collection)) return []
  return accessor.driver.listIndexes(database, collection)
}

export async function getValidator(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
): Promise<unknown> {
  const specs = await accessor.driver.listCollectionsDetailed(database, {
    name: collection,
  })
  for (const spec of specs) {
    const validator = spec.options?.validator as { $jsonSchema?: unknown } | undefined
    return validator?.$jsonSchema ?? null
  }
  return null
}

export async function getIndexStats(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
): Promise<Record<string, MongoIndexAccess>> {
  return accessor.driver.getIndexStats(database, collection)
}
