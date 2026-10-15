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
import { enoent } from '../../errors/fs.ts'
import { FileStat, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { databaseExists, entityExists, listCollections, listDatabases } from './client.ts'
import { detectScope, entityKind } from './scope.ts'
import { KIND_TO_DIR } from './types.ts'

export const ENTITY_FILES = ['schema.json', 'documents.jsonl'] as const

/** ENOENT unless the slotted database exists. */
export async function databaseGuard(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  if (!(await databaseExists(accessor, match.slots.database ?? ''))) {
    throw enoent(virtual)
  }
}

/** ENOENT unless the slotted collection or view exists. */
export async function entityGuard(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  const exists = await entityExists(
    accessor,
    match.slots.database ?? '',
    match.slots.name ?? '',
    entityKind(match),
  )
  if (!exists) throw enoent(virtual)
}

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

// What each kind's stat carries in `extra`, listed or not.
export const EXTRAS = {
  database: databaseExtra,
  kind_dir: kindDirExtra,
  database_json: databaseExtra,
  schema_json: entityExtra,
  entity: entityExtra,
  documents: entityExtra,
}

function dirs(names: readonly string[]): FileStat[] {
  return names.map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
}

async function listRoot(accessor: MongoDBAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  return dirs(await listDatabases(accessor))
}

function listDatabase(_accessor: MongoDBAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  // database.json, collections/ and views/ exist by construction under
  // every database that exists at all (the guard has already run).
  return Promise.resolve([
    new FileStat({ name: 'database.json', type: FileType.FILE }),
    ...dirs(Object.values(KIND_TO_DIR)),
  ])
}

async function listKindDir(accessor: MongoDBAccessor, match: ScopeMatch): Promise<FileStat[]> {
  return dirs(await listCollections(accessor, match.slots.database ?? '', entityKind(match)))
}

function listEntityFiles(_accessor: MongoDBAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  return Promise.resolve(ENTITY_FILES.map((name) => new FileStat({ name, type: FileType.FILE })))
}

export const readdir = makeReaddir<MongoDBAccessor>(detectScope, {
  listers: {
    root: listRoot,
    database: listDatabase,
    kind_dir: listKindDir,
    entity: listEntityFiles,
  },
  guards: {
    database: databaseGuard,
    kind_dir: databaseGuard,
    entity: entityGuard,
  },
  extras: EXTRAS,
})
