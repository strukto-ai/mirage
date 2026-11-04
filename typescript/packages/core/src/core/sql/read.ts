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

import type { SqlAccessor } from '../../accessor/sql.ts'
import { eisdir } from '../../errors/fs.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { readBytes } from './data.ts'
import { isDir } from './inode.ts'
import { found, walk } from './path.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Sql accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: SqlAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const timer = startOp()
  const node = found(await walk(accessor, path), path)
  if (isDir(node)) throw eisdir(path)
  const data = await readBytes(accessor, node, options?.offset ?? 0, options?.size ?? null)
  record('read', path.virtual, VFSName.SQL, data.byteLength, timer)
  return data
}
