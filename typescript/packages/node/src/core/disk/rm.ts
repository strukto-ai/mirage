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

import { errnoOf } from '@struktoai/mirage-core/errors/posix'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { resolveInside } from './utils.ts'

export async function rmR(accessor: DiskAccessor, path: PathSpec): Promise<void> {
  const full = await resolveInside(accessor.root, path)
  const timer = startOp()
  let failure: unknown = null
  let removed = false
  // Gone already is removed, as `rm -f` takes it; a link is removed, never
  // followed. A directory's files go before the walk descends, in the order
  // Python's rmtree takes them.
  const remove = async (target: string, isDir: boolean): Promise<void> => {
    if (isDir) {
      const entries = await readdir(target, { withFileTypes: true })
      for (const entry of entries.filter((e) => !e.isDirectory())) {
        await remove(join(target, entry.name), false)
      }
      for (const entry of entries.filter((e) => e.isDirectory())) {
        await remove(join(target, entry.name), true)
      }
    }
    try {
      await (isDir ? rmdir(target) : unlink(target))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return
    }
    removed = true
  }
  try {
    const top = await lstat(full).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    if (top !== null) await remove(full, top.isDirectory())
  } catch (err) {
    failure = err
    throw err
  } finally {
    // Also when the walk raised: one that fails part-way has already
    // removed entries, as on the object stores.
    const changed = failure === null || removed
    record('rm_r', path.virtual, VFSName.DISK, 0, timer, {
      status: failure === null ? 'ok' : changed ? 'partial' : 'failed',
      changed,
      errno: errnoOf(failure),
    })
  }
}
