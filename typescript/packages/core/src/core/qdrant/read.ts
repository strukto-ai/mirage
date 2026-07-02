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
import { decodeBase64 } from '../../utils/base64.ts'
import { enoent } from '../../utils/errors.ts'
import { renderJson, renderText } from './render.ts'
import { type QdrantScope, ScopeLevel, detectScope } from './scope.ts'

async function resolveRow(
  accessor: QdrantAccessor,
  scope: QdrantScope,
  notFoundPath: string,
): Promise<QdrantRow> {
  const config = accessor.config
  if (scope.table === null || scope.rowId === null) throw enoent(notFoundPath)
  const row = await accessor.rowRecord(scope.table, config.idField, scope.rowId)
  if (row === null) throw enoent(notFoundPath)
  return row
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return decodeBase64(value)
  throw new Error('blob column is not bytes or base64 string')
}

export async function read(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)
  if (scope.level !== ScopeLevel.ROW) throw enoent(spec.virtual)
  const row = await resolveRow(accessor, scope, spec.virtual)
  if (scope.kind === 'blob') {
    if (config.blobField === null) throw enoent(spec.virtual)
    const blobValue = row[config.blobField]
    if (blobValue === null || blobValue === undefined) throw enoent(spec.virtual)
    return blobBytes(blobValue)
  }
  if (scope.kind === 'txt') {
    if (
      config.textField === null ||
      row[config.textField] === null ||
      row[config.textField] === undefined
    ) {
      throw enoent(spec.virtual)
    }
    return renderText(row, config)
  }
  return renderJson(row, config)
}
