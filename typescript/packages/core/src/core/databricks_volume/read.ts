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

import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import { dbxFetch } from './_client.ts'
import { isNotFound, notFoundError } from './errors.ts'
import { backendPath } from './path.ts'

export function rangeHeader(offset: number, size: number | null): string | null {
  if (offset < 0) throw new Error('offset must be non-negative')
  if (size !== null && size < 0) throw new Error('size must be non-negative')
  if (offset === 0 && size === null) return null
  if (size === null) return `bytes=${String(offset)}-`
  return `bytes=${String(offset)}-${String(offset + size - 1)}`
}

export interface DbxReadOptions {
  offset?: number
  size?: number
}

export async function readBytes(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: DbxReadOptions = {},
): Promise<Uint8Array> {
  const virtual = path.virtual
  const remotePath = backendPath(accessor.config, path)
  const startMs = performance.now()
  const offset = options.offset ?? 0
  const size = options.size ?? null
  if (size === 0) {
    record('read', virtual, ResourceName.DATABRICKS_VOLUME, 0, startMs)
    return new Uint8Array(0)
  }
  const range = rangeHeader(offset, size)
  const headers: Record<string, string> = { Accept: 'application/octet-stream' }
  if (range !== null) headers.Range = range
  let r: Response
  try {
    r = await dbxFetch(accessor, 'GET', 'files', remotePath, { headers })
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(path.virtual)
    throw exc
  }
  const data = new Uint8Array(await r.arrayBuffer())
  record('read', virtual, ResourceName.DATABRICKS_VOLUME, data.byteLength, startMs)
  return data
}
