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
import { renderCard } from './render.ts'
import { type LanceDBScope, ScopeLevel, detectScope } from './scope.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

async function resolveRow(accessor: LanceDBAccessor, scope: LanceDBScope): Promise<LanceRow> {
  const config = accessor.config
  if (scope.table === null || scope.rowId === null) throw notFound(scope.resourcePath)
  const row = await accessor.driver.rowRecord(scope.table, config.idColumn, scope.rowId)
  if (row === null) throw notFound(scope.resourcePath)
  return row
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'base64'))
  throw new Error('blob column is not bytes or base64 string')
}

export async function read(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)
  if (scope.level !== ScopeLevel.ROW) throw notFound(spec.virtual)
  const row = await resolveRow(accessor, scope)
  if (scope.blob) {
    if (config.blobColumn === null) throw notFound(spec.virtual)
    return blobBytes(row[config.blobColumn])
  }
  return renderCard(row, config)
}
