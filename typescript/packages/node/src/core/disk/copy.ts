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
import { copyFile, stat } from 'node:fs/promises'
import { invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import { diskError } from './errors.ts'
import { resolveSafe } from './utils.ts'

export async function copy(accessor: DiskAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = resolveSafe(accessor.root, src.mountPath)
  const d = resolveSafe(accessor.root, dst.mountPath)
  try {
    await copyFile(s, d)
  } catch (err) {
    // copyFile reports ENOENT both for a missing source and for a missing
    // destination parent, so the operand to blame is only knowable after
    // the failure: probe the source to tell them apart.
    let blame = dst
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const srcMissing = await stat(s).then(
        () => false,
        () => true,
      )
      if (srcMissing) blame = src
    }
    throw diskError(err, blame)
  }
  await invalidateAfterWrite(dst)
}
