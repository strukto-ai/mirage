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
import { rename as fsRename, stat as fsStat } from 'node:fs/promises'

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { resolveInside } from './utils.ts'

export async function rename(accessor: DiskAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = await resolveInside(accessor.root, src)
  const d = await resolveInside(accessor.root, dst)
  const timer = startOp()
  try {
    await fsRename(s, d)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(src)
    }
    throw err
  }
  // Named as the object stores name it: a moved directory took its
  // subtree, which only "rename_prefix" retracts.
  const moved = await fsStat(d).then(
    (st) => st.isDirectory(),
    () => false,
  )
  const op = moved ? 'rename_prefix' : 'rename'
  record(op, src.virtual, VFSName.DISK, 0, timer)
  record(op, dst.virtual, VFSName.DISK, 0, timer)
}
