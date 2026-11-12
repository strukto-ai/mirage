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

import { rechunk } from '@struktoai/mirage-core/io/stream'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { bucket, gridfsKey } from './client.ts'
import { isNotFound } from './driver.ts'
import { resolveFileId } from './read.ts'

export async function* readStream(
  accessor: GridFSAccessor,
  path: PathSpec,
  onVersion?: (version: string | null) => void,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const raw = rawPathOf(path)
  const key = gridfsKey(raw, accessor.config)
  const fileId = await resolveFileId(accessor, path, key)
  onVersion?.(fileId.toString())
  const rec = recordStream('read', virtual, VFSName.GRIDFS)
  if (rec !== null) {
    const revision = fileId.toString()
    rec.fingerprint = revision
    rec.revision = revision
  }
  const b = await bucket(accessor)
  const readable = b.openDownloadStream(fileId)
  try {
    for await (const piece of rechunk(readable as AsyncIterable<Uint8Array>, 8192)) {
      if (rec !== null) rec.bytes += piece.byteLength
      yield piece
    }
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  if (rec !== null) rec.complete = true
}
