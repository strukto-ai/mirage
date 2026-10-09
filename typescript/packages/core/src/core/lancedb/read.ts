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
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { Reader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes } from '../vector/read.ts'
import { tableOf } from '../vector/scope.ts'
import type { LanceRow } from './types.ts'
import { renderCard } from './render.ts'

async function rowOf(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<LanceRow> {
  const config = accessor.config
  const row = await accessor.driver.rowRecord(
    tableOf(config.table, match),
    config.idColumn,
    match.slots.row_id ?? '',
  )
  if (row === null) throw enoent(virtual)
  return row
}

async function readCard(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const row = await rowOf(accessor, match, path.virtual)
  return renderCard(row, accessor.config)
}

async function readBlob(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const config = accessor.config
  if (config.blobColumn === null) throw enoent(path.virtual)
  const row = await rowOf(accessor, match, path.virtual)
  return blobBytes(row[config.blobColumn])
}

export const READERS: Record<string, Reader<LanceDBAccessor>> = {
  row_card: readCard,
  row_blob: readBlob,
}
