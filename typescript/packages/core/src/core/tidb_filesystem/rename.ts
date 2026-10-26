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
import { enoent, enotempty } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { move } from './client.ts'
import { checkRename, kindsOf } from './dest.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'

/**
 * Move a file or a directory with drive9's own rename, once one
 * fs:batch-stat has both ends resolved the way rename(2) needs.
 */
export async function rename(
  accessor: TiDBFilesystemAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  const kinds = await kindsOf(accessor, [...ancestors(d), d, ...ancestors(s), s])
  checkRename(kinds, src, s, dst, d)
  if (s === d) return
  try {
    await move(accessor, backendPath(accessor.config, src), backendPath(accessor.config, dst))
  } catch (exc) {
    if (hasStatus(exc, 409)) throw enotempty(dst)
    if (hasStatus(exc, 404)) throw enoent(src)
    throw exc
  }
}
