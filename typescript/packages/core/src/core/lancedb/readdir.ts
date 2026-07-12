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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { LanceRow } from './_driver.ts'
import { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { ScopeLevel, detectScope } from './scope.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

function rowFiles(rows: LanceRow[], config: LanceDBAccessor['config']): string[] {
  const names: string[] = []
  for (const row of rows) {
    const id = String(row[config.idColumn])
    names.push(`${id}.md`)
    if (config.blobColumn !== null) names.push(`${id}.${config.blobExt}`)
  }
  return names
}

export async function readdir(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)
  const base = rstripSlash(spec.virtual)

  if (scope.level === ScopeLevel.ROOT) {
    const tables = await accessor.driver.listTables()
    return tables.map((name) => `${base}/${name}`)
  }

  if (scope.level === ScopeLevel.GROUP_DIR && scope.table !== null) {
    const depth = Object.keys(scope.filters).length
    const total = config.groupBy.length
    let names: string[]
    if (depth < total) {
      names = await accessor.driver.distinct(
        scope.table,
        config.groupBy[depth] ?? '',
        scope.filters,
        config.maxRows,
      )
    } else {
      const rows = await accessor.driver.rowsMatching(
        scope.table,
        scope.filters,
        [config.idColumn],
        config.maxRows,
      )
      names = rowFiles(rows, config)
    }
    return names.map((name) => `${base}/${name}`)
  }

  throw notFound(spec.virtual)
}

export function isDirName(child: string, config: LanceDBAccessor['config']): boolean {
  // Row files are recognized by extension, so classification never
  // needs the stat fallback.
  const name = child.split('/').pop() ?? ''
  if (name.endsWith('.md')) return false
  if (config.blobColumn !== null && name.endsWith(`.${config.blobExt}`)) return false
  return true
}
