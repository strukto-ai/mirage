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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sha256Hex } from '../../utils/hash.ts'
import type { PostgresAccessor } from '../../accessor/postgres.ts'
import {
  estimatedRowCount,
  fetchColumns,
  listMatviews,
  listSchemas,
  listTables,
  listViews,
  tableSizeBytes,
} from './_client.ts'
import { detectScope } from './scope.ts'
import { enoent } from '../../utils/errors.ts'

async function schemaExists(accessor: PostgresAccessor, schema: string): Promise<boolean> {
  const schemas = await listSchemas(accessor, accessor.config.schemas)
  return schemas.includes(schema)
}

async function entityExists(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  entity: string,
): Promise<boolean> {
  let names: string[]
  if (kind === 'tables') {
    names = await listTables(accessor, schema)
  } else {
    const views = await listViews(accessor, schema)
    const mviews = await listMatviews(accessor, schema)
    names = [...new Set([...views, ...mviews])]
  }
  return names.includes(entity)
}

export async function stat(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const prefix = mountPrefixOf(spec.virtual, spec.resourcePath)
  let raw = spec.virtual
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const scope = detectScope(
    new PathSpec({ virtual: raw, directory: raw, resourcePath: mountKey(raw, prefix) }),
  )

  if (scope.level === 'root') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }
  if (scope.level === 'database_json') {
    return new FileStat({ name: 'database.json', type: FileType.JSON })
  }
  if (scope.level === 'schema') {
    if (!(await schemaExists(accessor, scope.schema))) throw enoent(spec)
    return new FileStat({
      name: scope.schema,
      type: FileType.DIRECTORY,
      extra: { schema: scope.schema },
    })
  }
  if (scope.level === 'kind') {
    if (!(await schemaExists(accessor, scope.schema))) throw enoent(spec)
    return new FileStat({
      name: scope.kind,
      type: FileType.DIRECTORY,
      extra: { schema: scope.schema, kind: scope.kind },
    })
  }
  if (scope.level === 'entity') {
    if (!(await entityExists(accessor, scope.schema, scope.kind, scope.entity))) throw enoent(spec)
    return new FileStat({
      name: scope.entity,
      type: FileType.DIRECTORY,
      extra: { schema: scope.schema, kind: scope.kind, name: scope.entity },
    })
  }
  if (scope.level === 'entity_schema') {
    if (!(await entityExists(accessor, scope.schema, scope.kind, scope.entity))) throw enoent(spec)
    return new FileStat({
      name: 'schema.json',
      type: FileType.JSON,
      extra: { schema: scope.schema, kind: scope.kind, name: scope.entity },
    })
  }
  if (scope.level === 'entity_rows') {
    if (!(await entityExists(accessor, scope.schema, scope.kind, scope.entity))) throw enoent(spec)
    return rowsStat(accessor, scope.schema, scope.kind, scope.entity)
  }
  throw enoent(spec)
}

async function rowsStat(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  entity: string,
): Promise<FileStat> {
  const cols = await fetchColumns(accessor, schema, entity)
  const rows = await estimatedRowCount(accessor, schema, entity)
  const size = await tableSizeBytes(accessor, schema, entity)
  const fingerprint = await sha256Hex(
    new TextEncoder().encode(JSON.stringify({ columns: cols, rows })),
  )
  // size stays null: tableSizeBytes is the on-disk storage size, not the
  // rendered JSONL length (FileStat.size must be render-derived or null,
  // see the CLAUDE.md FUSE rules). The storage size remains in extra.
  return new FileStat({
    name: 'rows.jsonl',
    type: FileType.TEXT,
    size: null,
    fingerprint,
    extra: {
      schema,
      kind,
      name: entity,
      row_count: rows,
      size_bytes: size,
    },
  })
}
