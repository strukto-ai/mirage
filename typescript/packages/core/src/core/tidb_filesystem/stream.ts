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

import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { rechunk } from '../../io/stream.ts'
import { recordStream } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { downloadStream } from './client.ts'
import { backendPath } from './path.ts'
import { readError } from './read.ts'

export async function* readStream(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  chunkSize = 8192,
): AsyncIterable<Uint8Array> {
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive')
  const rec = recordStream('read', path.virtual, VFSName.TIDB_FILESYSTEM)
  const remotePath = backendPath(accessor.config, path)
  try {
    for await (const piece of rechunk(downloadStream(accessor, remotePath), chunkSize)) {
      if (rec !== null) rec.bytes += piece.byteLength
      yield piece
    }
  } catch (exc) {
    throw (await readError(accessor, path, exc)) ?? exc
  }
}
