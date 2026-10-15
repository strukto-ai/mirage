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

import type { PostgresAccessor } from '../../accessor/postgres.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { enoent } from '../../errors/fs.ts'
import { FileStat, FileType } from '../../types.ts'
import { listMatviews, listSchemas, listTables, listViews } from './client.ts'
import { detectScope, ENTITY_FILES, KIND_DIRS } from './scope.ts'

export async function schemaGuard(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  const schemas = await listSchemas(accessor, accessor.config.schemas)
  if (!schemas.includes(match.slots.schema ?? '')) throw enoent(virtual)
}

export async function entityGuard(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  const schema = match.slots.schema ?? ''
  const kind = match.slots.kind ?? ''
  // An entity guard answers for its schema too: it replaces the listing
  // chain wherever it runs, so a table under a schema the mount's `schemas`
  // leaves out would otherwise read, stat and list as if the mount could see
  // it.
  if (!(await listSchemas(accessor, accessor.config.schemas)).includes(schema)) {
    throw enoent(virtual)
  }
  let names: string[]
  if (kind === 'tables') {
    names = await listTables(accessor, schema)
  } else {
    const views = await listViews(accessor, schema)
    const mviews = await listMatviews(accessor, schema)
    names = [...new Set([...views, ...mviews])]
  }
  if (!names.includes(match.slots.entity ?? '')) throw enoent(virtual)
}

function schemaExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '' }
}

function kindExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '', kind: match.slots.kind ?? '' }
}

function entityExtra(match: ScopeMatch): Record<string, string> {
  return {
    schema: match.slots.schema ?? '',
    kind: match.slots.kind ?? '',
    name: match.slots.entity ?? '',
  }
}

// What each kind's stat carries in `extra`, listed or not.
export const EXTRAS = {
  schema: schemaExtra,
  kind: kindExtra,
  entity: entityExtra,
  entity_schema: entityExtra,
  entity_semantic: entityExtra,
  entity_rows: entityExtra,
}

function dirs(names: readonly string[]): FileStat[] {
  return names.map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
}

async function listRoot(accessor: PostgresAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  const schemas = await listSchemas(accessor, accessor.config.schemas)
  return [new FileStat({ name: 'database.json', type: FileType.FILE }), ...dirs(schemas)]
}

function listSchema(_accessor: PostgresAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  // tables/ and views/ exist by construction under every schema, the same
  // way the entity files below do under every entity.
  return Promise.resolve(dirs(KIND_DIRS))
}

async function listEntities(accessor: PostgresAccessor, match: ScopeMatch): Promise<FileStat[]> {
  const schema = match.slots.schema ?? ''
  const kind = match.slots.kind ?? ''
  let names: string[]
  if (kind === 'tables') {
    names = await listTables(accessor, schema)
  } else {
    const views = await listViews(accessor, schema)
    const mviews = await listMatviews(accessor, schema)
    names = [...new Set([...views, ...mviews])].sort(compareCodePoints)
  }
  return dirs(names)
}

function listEntityFiles(_accessor: PostgresAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  return Promise.resolve(ENTITY_FILES.map((name) => new FileStat({ name, type: FileType.FILE })))
}

export const readdir = makeReaddir<PostgresAccessor>(detectScope, {
  listers: {
    root: listRoot,
    schema: listSchema,
    kind: listEntities,
    entity: listEntityFiles,
  },
  // Every lister above answers from the path alone, so without these a
  // schema or entity that does not exist reads as a real directory:
  // tables/ and views/ under any first segment, the entity files under
  // any third, and an empty listing (not ENOENT) for a missing schema's
  // tables/. Same guards stat runs, so the two answer alike.
  guards: {
    schema: schemaGuard,
    kind: schemaGuard,
    entity: entityGuard,
  },
  extras: EXTRAS,
})
