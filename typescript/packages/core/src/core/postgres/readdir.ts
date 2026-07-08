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
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import type { PostgresAccessor } from '../../accessor/postgres.ts'
import { listMatviews, listSchemas, listTables, listViews } from './_client.ts'
import { detectScope } from './scope.ts'
import { rstripSlash } from '../../utils/slash.ts'

export async function readdir(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const prefix = mountPrefixOf(spec.virtual, spec.resourcePath)
  let raw = spec.pattern !== null ? spec.directory : spec.virtual
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  const scope = detectScope(
    new PathSpec({ virtual: raw, directory: raw, resourcePath: mountKey(raw, prefix) }),
  )
  // Canonical key: no trailing slash (except root), or the same dir
  // indexes under two keys and cache hits return doubled-slash entries.
  const virtualKey = rstripSlash((prefix !== '' ? prefix : '') + raw) || '/'

  if (scope.level === 'root') {
    return listRoot(accessor, virtualKey, index, prefix)
  }
  if (scope.level === 'schema') {
    const base = rstripSlash(raw)
    return [`${prefix}${base}/tables`, `${prefix}${base}/views`]
  }
  if (scope.level === 'kind') {
    return listEntities(accessor, scope.schema, scope.kind, virtualKey, index, prefix, raw)
  }
  if (scope.level === 'entity') {
    const base = rstripSlash(raw)
    return [`${prefix}${base}/schema.json`, `${prefix}${base}/rows.jsonl`]
  }
  const err = new Error(raw) as Error & { code?: string }
  err.code = 'ENOENT'
  throw err
}

async function listRoot(
  accessor: PostgresAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== null && cached.entries !== undefined) return cached.entries
  }
  const schemas = await listSchemas(accessor, accessor.config.schemas)
  const entries: [string, IndexEntry][] = [
    [
      'database.json',
      new IndexEntry({
        id: 'database.json',
        name: 'database.json',
        resourceType: 'postgres/database_json',
        vfsName: 'database.json',
      }),
    ],
  ]
  for (const s of schemas) {
    entries.push([
      s,
      new IndexEntry({
        id: s,
        name: s,
        resourceType: 'postgres/schema',
        vfsName: s,
      }),
    ])
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return entries.map(([name]) => `${prefix}/${name}`)
}

async function listEntities(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
  raw: string,
): Promise<string[]> {
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== null && cached.entries !== undefined) return cached.entries
  }
  let names: string[]
  if (kind === 'tables') {
    names = await listTables(accessor, schema)
  } else {
    const views = await listViews(accessor, schema)
    const mviews = await listMatviews(accessor, schema)
    names = [...new Set([...views, ...mviews])].sort()
  }
  const entries: [string, IndexEntry][] = names.map((n) => [
    n,
    new IndexEntry({
      id: n,
      name: n,
      resourceType: `postgres/${kind.replace(/s$/, '')}`,
      vfsName: n,
    }),
  ])
  if (index !== undefined) await index.setDir(virtualKey, entries)
  const base = rstripSlash(raw)
  return entries.map(([n]) => `${prefix}${base}/${n}`)
}
