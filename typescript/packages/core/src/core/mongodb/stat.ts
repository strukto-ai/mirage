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
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { makeStat } from '../hierarchy/stat.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { countDocuments, isView, listIndexes } from './client.ts'
import { databaseGuard, entityGuard, readdir } from './readdir.ts'
import { detectScope, entityKind } from './scope.ts'
import { EntityKind } from './types.ts'

function databaseExtra(match: ScopeMatch): Record<string, string> {
  return { database: match.slots.database ?? '' }
}

function kindDirExtra(match: ScopeMatch): Record<string, string> {
  return { database: match.slots.database ?? '', kind: entityKind(match) }
}

function entityExtra(match: ScopeMatch): Record<string, string> {
  return {
    database: match.slots.database ?? '',
    kind: entityKind(match),
    name: match.slots.name ?? '',
  }
}

async function entityStat(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  await entityGuard(accessor, match, path.virtual)
  const database = match.slots.database ?? ''
  const name = match.slots.name ?? ''
  const docCount = await countDocuments(accessor, database, name)
  return new FileStat({
    name,
    type: FileType.DIRECTORY,
    extra: {
      database,
      kind: entityKind(match),
      name,
      document_count: docCount,
    },
  })
}

async function documentsStat(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  await entityGuard(accessor, match, path.virtual)
  const database = match.slots.database ?? ''
  const name = match.slots.name ?? ''
  const view = entityKind(match) === EntityKind.VIEW || (await isView(accessor, database, name))
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
    type: FileType.FILE,
    content: ContentType.TEXT,
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

export const stat = makeStat<MongoDBAccessor>(detectScope, readdir, {
  guards: {
    database: databaseGuard,
    kind_dir: databaseGuard,
    database_json: databaseGuard,
    schema_json: entityGuard,
  },
  extras: {
    database: databaseExtra,
    kind_dir: kindDirExtra,
    database_json: databaseExtra,
    schema_json: entityExtra,
  },
  overrides: {
    entity: entityStat,
    documents: documentsStat,
  },
})
