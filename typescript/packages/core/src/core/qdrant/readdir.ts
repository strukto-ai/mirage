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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { QdrantRow } from './_client.ts'
import { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { ScopeLevel, detectScope } from './scope.ts'

function rowFiles(rows: QdrantRow[], config: QdrantAccessor['config']): string[] {
  const names: string[] = []
  for (const row of rows) {
    const id = String(row[config.idField])
    names.push(`${id}.json`)
    if (
      config.textField !== null &&
      row[config.textField] !== null &&
      row[config.textField] !== undefined
    )
      names.push(`${id}.txt`)
    if (
      config.blobField !== null &&
      row[config.blobField] !== null &&
      row[config.blobField] !== undefined
    )
      names.push(`${id}.${config.blobExt}`)
  }
  return names
}

export async function readdir(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)
  const base = rstripSlash(spec.virtual)

  if (scope.level === ScopeLevel.ROOT) {
    const tables = await accessor.listTables()
    return tables.map((name) => `${base}/${name}`)
  }

  if (scope.level === ScopeLevel.GROUP_DIR && scope.table !== null) {
    const depth = Object.keys(scope.filters).length
    const total = config.groupBy.length
    let names: string[]
    if (depth < total) {
      names = await accessor.distinct(
        scope.table,
        config.groupBy[depth] ?? '',
        scope.filters,
        config.maxRows,
      )
    } else {
      const rows = await accessor.rowsMatching(
        scope.table,
        scope.filters,
        [config.idField],
        config.maxRows,
      )
      names = rowFiles(rows, config)
    }
    return names.map((name) => `${base}/${name}`)
  }

  throw enoent(spec.virtual)
}
