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
import { ancestors, norm } from '../../utils/path.ts'
import { upload } from './client.ts'
import { checkWriteTarget, kindsOf } from './dest.ts'
import { backendPath } from './path.ts'

/**
 * Replace a file's bytes once one fs:batch-stat has found its parent chain
 * all directories and the path itself no directory, since drive9 would make
 * the parents and file the bytes beside a directory. A stream is spooled
 * first, as a multipart upload states its size.
 */
export async function write(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  data: ByteSource | ByteSpool,
): Promise<void> {
  if (!(data instanceof Uint8Array) && !(data instanceof ByteSpool)) {
    const spool = new ByteSpool()
    try {
      await spool.fill(data)
      await write(accessor, path, spool)
    } finally {
      await spool.close()
    }
    return
  }
  const key = norm(path.mountPath)
  const timer = startOp()
  const kinds = await kindsOf(accessor, [...ancestors(key), key])
  checkWriteTarget(kinds, path, key)
  await upload(accessor, backendPath(accessor.config, path), data)
  const size = data instanceof ByteSpool ? data.size : data.byteLength
  record('write', path.virtual, VFSName.TIDB_FILESYSTEM, size, timer)
}
