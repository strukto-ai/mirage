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
import { IndexEntry } from '../../cache/index/config.ts'
import { enoent, isEnoent } from '../../errors/fs.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { databaseExists, entityExists, listCollections, listDatabases } from './client.ts'
import { detectScope, entityKind } from './scope.ts'
import { KIND_TO_DIR, KIND_TO_RESOURCE_TYPE, RESOURCE_TYPE_DATABASE } from './types.ts'

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

/**
 * Whether `entityGuard` admits the collection a match names. For the bespoke
 * fast paths (`tail -f` and `wc -l` on `documents.jsonl`), which query the
 * collection by the names in the path: they take the fast path only for a
 * collection the mount can see, and otherwise hand the operand to the
 * generic, which stats it through the same guard and reports it the way GNU
 * names a missing file. `countDocuments` answers 0 for a collection that does
 * not exist, so without it `wc -l` printed a count for a missing file.
 * Mirrors `documents_exist` in `mirage/core/mongodb/readdir.py`.
 */
export async function documentsExist(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<boolean> {
  try {
    await entityGuard(accessor, match, virtual)
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
  return true
}

async function listRoot(
  accessor: MongoDBAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const dbs = await listDatabases(accessor)
  return dbs.map((db) => [
    db,
    new IndexEntry({ id: db, name: db, resourceType: RESOURCE_TYPE_DATABASE, vfsName: db }),
  ])
}

function listDatabase(
  _accessor: MongoDBAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  // database.json, collections/ and views/ exist by construction under
  // every database that exists at all (the guard has already run).
  const names = ['database.json', ...Object.values(KIND_TO_DIR)]
  return Promise.resolve(
    names.map((name): [string, IndexEntry] => [
      name,
      new IndexEntry({ id: name, name, resourceType: 'mongodb/database_entry', vfsName: name }),
    ]),
  )
}

async function listKindDir(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const kind = entityKind(match)
  const names = await listCollections(accessor, match.slots.database ?? '', kind)
  return names.map((name) => [
    name,
    new IndexEntry({ id: name, name, resourceType: KIND_TO_RESOURCE_TYPE[kind], vfsName: name }),
  ])
}

function listEntityFiles(
  _accessor: MongoDBAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  return Promise.resolve(
    ENTITY_FILES.map((name): [string, IndexEntry] => [
      name,
      new IndexEntry({ id: name, name, resourceType: 'mongodb/entity_file', vfsName: name }),
    ]),
  )
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
})
