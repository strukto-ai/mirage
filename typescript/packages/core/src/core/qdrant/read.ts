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
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { Reader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes } from '../vector/read.ts'
import { tableOf } from '../vector/scope.ts'
import { pointIdFromStem, rowStem } from './naming.ts'
import { fieldValue } from './payload.ts'
import { rowRecord, type QdrantRow } from './query.ts'
import { renderJson, renderText } from './render.ts'

async function rowOf(
  accessor: QdrantAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<QdrantRow> {
  // The label is stripped before the retrieve, so every spelling that ends
  // in __<id> reaches the point; only the stem readdir publishes names it,
  // so an alias reads as absent rather than as the file.
  const config = accessor.config
  const stem = match.slots.row_id ?? ''
  const row = await rowRecord(
    accessor,
    tableOf(config.collection, match),
    config.idField,
    pointIdFromStem(stem, config),
  )
  if (row === null || rowStem(row, config) !== stem) throw enoent(virtual)
  return row
}

async function readJson(
  accessor: QdrantAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const row = await rowOf(accessor, match, path.virtual)
  return renderJson(row, accessor.config)
}

async function readText(
  accessor: QdrantAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const config = accessor.config
  const row = await rowOf(accessor, match, path.virtual)
  if (
    config.textField === null ||
    fieldValue(row, config.textField) === null ||
    fieldValue(row, config.textField) === undefined
  ) {
    throw enoent(path.virtual)
  }
  return renderText(row, config)
}

async function readBlob(
  accessor: QdrantAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const config = accessor.config
  if (config.blobField === null) throw enoent(path.virtual)
  const row = await rowOf(accessor, match, path.virtual)
  const value = fieldValue(row, config.blobField)
  if (value === null || value === undefined) throw enoent(path.virtual)
  return blobBytes(value)
}

export const READERS: Record<string, Reader<QdrantAccessor>> = {
  row_json: readJson,
  row_text: readText,
  row_blob: readBlob,
}
