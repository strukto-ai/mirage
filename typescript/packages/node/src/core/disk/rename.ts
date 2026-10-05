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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { rename as fsRename, lstat } from 'node:fs/promises'
import { invalidateAfterMove } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import { resolveInside } from './utils.ts'

/**
 * Whether a rename source may have anything cached beneath it. Only a
 * regular file narrows the eviction. A directory relocates its subtree;
 * anything else, or a source that is gone, keeps the subtree and leaves the
 * rename to report its own error.
 */
async function holdsSubtree(path: string): Promise<boolean> {
  try {
    return !(await lstat(path)).isFile()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  }
}

export async function rename(accessor: DiskAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = await resolveInside(accessor.root, src)
  const d = await resolveInside(accessor.root, dst)
  // The kernel refuses a file over a directory and a directory over a file,
  // so the source's kind holds for both ends: a folder's subtree is stale
  // under both names, a file has nothing beneath either. Classified before
  // the rename, while the source is still there; evicted after it, so a
  // listing read in between cannot refill the pre-rename view.
  const folder = await holdsSubtree(s)
  try {
    await fsRename(s, d)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(src)
    }
    throw err
  }
  await invalidateAfterMove(src, folder)
  await invalidateAfterMove(dst, folder)
}
