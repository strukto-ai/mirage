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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { databaseExists, entityExists, listCollections, listDatabases } from './_client.ts'
import { detectScope } from './scope.ts'
import type { EntityKind } from './types.ts'
import { KIND_TO_DIR, KIND_TO_RESOURCE_TYPE, RESOURCE_TYPE_DATABASE, ScopeLevel } from './types.ts'
import { rstripSlash } from '../../utils/slash.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

export async function readdir(
  accessor: MongoDBAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const prefix = mountPrefixOf(spec.virtual, spec.resourcePath)
  const scope = detectScope(spec)
  const virtualKey = rstripSlash(`${prefix}${scope.resourcePath}`) || '/'

  if (scope.level === ScopeLevel.ROOT) {
    return listRoot(accessor, virtualKey, index, prefix)
  }

  if (scope.level === ScopeLevel.DATABASE && scope.database !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.virtual)
    const base = `${prefix}/${scope.database}`
    return [`${base}/database.json`, `${base}/collections`, `${base}/views`]
  }

  if (scope.level === ScopeLevel.KIND_DIR && scope.database !== null && scope.kind !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.virtual)
    return listKindDir(accessor, scope.database, scope.kind, virtualKey, index, prefix)
  }

  if (
    scope.level === ScopeLevel.ENTITY &&
    scope.database !== null &&
    scope.kind !== null &&
    scope.name !== null
  ) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.virtual)
    }
    const base = `${prefix}/${scope.database}/${KIND_TO_DIR[scope.kind]}/${scope.name}`
    return [`${base}/schema.json`, `${base}/documents.jsonl`]
  }

  throw notFound(spec.virtual)
}

async function listRoot(
  accessor: MongoDBAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== null && cached.entries !== undefined) return cached.entries
  }
  const dbs = await listDatabases(accessor)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const db of dbs) {
    entries.push([
      db,
      new IndexEntry({
        id: db,
        name: db,
        resourceType: RESOURCE_TYPE_DATABASE,
        vfsName: db,
      }),
    ])
    names.push(`${prefix}/${db}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function listKindDir(
  accessor: MongoDBAccessor,
  database: string,
  kind: EntityKind,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== null && cached.entries !== undefined) return cached.entries
  }
  const names = await listCollections(accessor, database, kind)
  const base = `${prefix}/${database}/${KIND_TO_DIR[kind]}`
  const entries: [string, IndexEntry][] = []
  const out: string[] = []
  for (const name of names) {
    entries.push([
      name,
      new IndexEntry({
        id: name,
        name,
        resourceType: KIND_TO_RESOURCE_TYPE[kind],
        vfsName: name,
      }),
    ])
    out.push(`${base}/${name}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return out
}
