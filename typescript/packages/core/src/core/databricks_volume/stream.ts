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
import { rechunk } from '../../io/stream.ts'
import { recordStream } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { downloadStream } from './client.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { enoent } from '../../errors/fs.ts'

const DEFAULT_CHUNK_SIZE = 8192

export async function* readStream(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const remotePath = backendPath(accessor.config, path)
  const rec = recordStream('read', virtual, VFSName.DATABRICKS_VOLUME)
  try {
    for await (const piece of rechunk(downloadStream(accessor, remotePath), DEFAULT_CHUNK_SIZE)) {
      if (rec !== null) rec.bytes += piece.byteLength
      yield piece
    }
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(path.virtual)
    throw exc
  }
}
