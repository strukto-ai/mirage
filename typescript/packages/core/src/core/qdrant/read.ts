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
import type { QdrantRow } from './client.ts'
import { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { makeRead, type Reader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes, renderJson, renderText } from './render.ts'
import { detectFor, tableOf } from './scope.ts'
import { fieldValue, pointIdFromStem } from './fields.ts'

async function rowOf(
  accessor: QdrantAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<QdrantRow> {
  const config = accessor.config
  const row = await accessor.rowRecord(
    tableOf(config, match),
    config.idField,
    pointIdFromStem(match.slots.row_id ?? '', config),
  )
  if (row === null) throw enoent(virtual)
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

const READERS: Record<string, Reader<QdrantAccessor>> = {
  row_json: readJson,
  row_text: readText,
  row_blob: readBlob,
}

function buildRead(accessor: QdrantAccessor) {
  return makeRead(detectFor(accessor), READERS)
}

const readFor = perAccessor(buildRead)

export async function read(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return readFor(accessor)(accessor, spec, index)
}
