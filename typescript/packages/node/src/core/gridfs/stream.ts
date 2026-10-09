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

import { recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { bucket, gridfsKey } from './client.ts'
import { isNoFileError, resolveFileId } from './read.ts'

const DEFAULT_CHUNK_SIZE = 8192

export async function* readStream(
  accessor: GridFSAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const raw = rawPathOf(path)
  const key = gridfsKey(raw, accessor.config)
  const rec = recordStream('read', virtual, VFSName.GRIDFS)
  const fileId = await resolveFileId(accessor, path, key)
  if (rec !== null) {
    const revision = fileId.toString()
    rec.fingerprint = revision
    rec.revision = revision
  }
  const b = await bucket(accessor)
  const readable = b.openDownloadStream(fileId)
  let pending: Uint8Array = new Uint8Array(0)
  try {
    for await (const chunk of readable as AsyncIterable<Uint8Array>) {
      const merged = new Uint8Array(pending.byteLength + chunk.byteLength)
      merged.set(pending, 0)
      merged.set(chunk, pending.byteLength)
      pending = merged
      while (pending.byteLength >= DEFAULT_CHUNK_SIZE) {
        const piece = pending.slice(0, DEFAULT_CHUNK_SIZE)
        if (rec !== null) rec.bytes += piece.byteLength
        yield piece
        pending = pending.slice(DEFAULT_CHUNK_SIZE)
      }
    }
  } catch (err) {
    if (isNoFileError(err)) throw enoent(path)
    throw err
  }
  if (pending.byteLength > 0) {
    if (rec !== null) rec.bytes += pending.byteLength
    yield pending
  }
}
