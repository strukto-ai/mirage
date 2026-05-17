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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { countDocuments, databaseExists, entityExists, isView, listIndexes } from './_client.ts'
import { detectScope } from './scope.ts'
import { EntityKind, KIND_TO_DIR, ScopeLevel } from './types.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

export async function stat(
  accessor: MongoDBAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const scope = detectScope(spec)

  if (scope.level === ScopeLevel.ROOT) {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }

  if (scope.level === ScopeLevel.DATABASE && scope.database !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.original)
    return new FileStat({
      name: scope.database,
      type: FileType.DIRECTORY,
      extra: { database: scope.database },
    })
  }

  if (scope.level === ScopeLevel.KIND_DIR && scope.database !== null && scope.kind !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.original)
    return new FileStat({
      name: KIND_TO_DIR[scope.kind],
      type: FileType.DIRECTORY,
      extra: { database: scope.database, kind: scope.kind },
    })
  }

  if (
    scope.level === ScopeLevel.ENTITY &&
    scope.database !== null &&
    scope.kind !== null &&
    scope.name !== null
  ) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.original)
    }
    const docCount = await countDocuments(accessor, scope.database, scope.name)
    return new FileStat({
      name: scope.name,
      type: FileType.DIRECTORY,
      extra: {
        database: scope.database,
        kind: scope.kind,
        name: scope.name,
        document_count: docCount,
      },
    })
  }

  if (
    scope.level === ScopeLevel.DOCUMENTS &&
    scope.database !== null &&
    scope.kind !== null &&
    scope.name !== null
  ) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.original)
    }
    return documentsStat(accessor, scope.database, scope.kind, scope.name)
  }

  if (
    scope.level === ScopeLevel.SCHEMA_JSON &&
    scope.database !== null &&
    scope.kind !== null &&
    scope.name !== null
  ) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.original)
    }
    return new FileStat({
      name: 'schema.json',
      type: FileType.TEXT,
      extra: {
        database: scope.database,
        kind: scope.kind,
        name: scope.name,
      },
    })
  }

  if (scope.level === ScopeLevel.DATABASE_JSON && scope.database !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.original)
    return new FileStat({
      name: 'database.json',
      type: FileType.TEXT,
      extra: { database: scope.database },
    })
  }

  throw notFound(spec.original)
}

async function documentsStat(
  accessor: MongoDBAccessor,
  database: string,
  kind: EntityKind,
  name: string,
): Promise<FileStat> {
  const view = kind === EntityKind.VIEW || (await isView(accessor, database, name))
  const docCount = await countDocuments(accessor, database, name)
  let indexInfo: { name: unknown; keys: Record<string, unknown> }[] = []
  if (!view) {
    const indexes = await listIndexes(accessor, database, name)
    indexInfo = indexes.map((idx) => ({
      name: idx.name ?? null,
      keys: { ...((idx.key as Record<string, unknown> | undefined) ?? {}) },
    }))
  }
  return new FileStat({
    name: 'documents.jsonl',
    type: FileType.TEXT,
    size: null,
    extra: {
      database,
      name,
      kind: view ? EntityKind.VIEW : EntityKind.COLLECTION,
      document_count: docCount,
      indexes: indexInfo,
    },
  })
}
