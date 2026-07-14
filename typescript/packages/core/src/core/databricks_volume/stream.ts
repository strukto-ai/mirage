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
import { recordStream } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import { dbxFetch } from './_client.ts'
import { isNotFound, notFoundError } from './errors.ts'
import { backendPath } from './path.ts'
import { readBytes } from './read.ts'

const DEFAULT_CHUNK_SIZE = 8192

function concatChunks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

export async function* readStream(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const remotePath = backendPath(accessor.config, path)
  const rec = recordStream('read', virtual, ResourceName.DATABRICKS_VOLUME)
  let r: Response
  try {
    r = await dbxFetch(accessor, 'GET', 'files', remotePath, {
      headers: { Accept: 'application/octet-stream' },
    })
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(path.virtual)
    throw exc
  }
  const body = r.body
  if (body === null) return
  const reader = body.getReader()
  let pending: Uint8Array = new Uint8Array(0)
  let completed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      pending = concatChunks(pending, value)
      while (pending.byteLength >= DEFAULT_CHUNK_SIZE) {
        const piece = pending.slice(0, DEFAULT_CHUNK_SIZE)
        if (rec !== null) rec.bytes += piece.byteLength
        yield piece
        pending = pending.slice(DEFAULT_CHUNK_SIZE)
      }
    }
    if (pending.byteLength > 0) {
      if (rec !== null) rec.bytes += pending.byteLength
      yield pending
    }
  } finally {
    try {
      if (!completed) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

export async function rangeRead(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return readBytes(accessor, path, undefined, { offset: start, size: end - start })
}
