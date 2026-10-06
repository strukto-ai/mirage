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
import { stat as fsStat, unlink as fsUnlink } from 'node:fs/promises'
import { invalidateAfterUnlink } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir } from '@struktoai/mirage-core/errors/fs'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function unlink(accessor: DiskAccessor, path: PathSpec): Promise<void> {
  const full = await resolveInside(accessor.root, path)
  try {
    await fsUnlink(full)
  } catch (err) {
    // macOS answers unlink(2) on a directory with EPERM; Linux, whose
    // answer every other backend gives, with EISDIR.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      const isDir = await fsStat(full).then(
        (st) => st.isDirectory(),
        () => false,
      )
      if (isDir) throw eisdir(path)
    }
    throw diskError(err, path)
  }
  await invalidateAfterUnlink(path)
}
