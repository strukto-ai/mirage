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
import { eisdir, fsError } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { windowFor } from '../../utils/ranges.ts'
import { download } from './client.ts'
import { kindsOf, lookupError } from './dest.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'

/**
 * The errno a failed download answers with, null for any other failure.
 * drive9 answers 404 for a directory as for a missing path, and 422 for a
 * file in the extent layout, whose blocks only its FUSE client reads.
 */
export async function readError(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  exc: unknown,
): Promise<FsError | null> {
  if (hasStatus(exc, 422)) return fsError(path, 'ENOTSUP')
  if (!hasStatus(exc, 404)) return null
  const key = norm(path.mountPath)
  const kinds = await kindsOf(accessor, [...ancestors(key), key])
  if (kinds.get(key)?.isDir === true) return eisdir(path)
  return lookupError(kinds, path, key)
}

export async function read(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const virtual = path.virtual
  const remotePath = backendPath(accessor.config, path)
  const timer = startOp()
  if (size === 0) {
    record('read', virtual, VFSName.TIDB_FILESYSTEM, 0, timer)
    return new Uint8Array(0)
  }
  let data: Uint8Array
  try {
    data = await download(accessor, remotePath, windowFor(offset, size))
  } catch (exc) {
    throw (await readError(accessor, path, exc)) ?? exc
  }
  record('read', virtual, VFSName.TIDB_FILESYSTEM, data.byteLength, timer)
  return data
}
