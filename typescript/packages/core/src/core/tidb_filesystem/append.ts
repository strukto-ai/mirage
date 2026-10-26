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
import { ByteSpool } from '../../io/spool.ts'
import type { ByteSource } from '../../io/types.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { appendByStreamedRewrite } from '../generic/rewrite.ts'
import { appendTo } from './client.ts'
import { backendPath } from './path.ts'
import { stat } from './stat.ts'
import { readStream } from './stream.ts'
import { write } from './write.ts'

/**
 * Add bytes to the end of a file. A file drive9 keeps in object storage takes
 * them natively, so only its last part and the new bytes move. Any other path
 * is read and written back whole, which makes a missing file and refuses a
 * directory.
 */
export async function append(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  data: ByteSource,
): Promise<void> {
  const spool = new ByteSpool()
  try {
    await spool.fill(data)
    const timer = startOp()
    const remote = backendPath(accessor.config, path)
    if (spool.size > 0 && (await appendTo(accessor, remote, spool))) {
      record('append', path.virtual, VFSName.TIDB_FILESYSTEM, spool.size, timer)
      return
    }
    await appendByStreamedRewrite(
      (p) => readStream(accessor, p),
      (p, body) => write(accessor, p, body),
      (p) => stat(accessor, p),
      path,
      spool.stream(),
    )
  } finally {
    await spool.close()
  }
}
