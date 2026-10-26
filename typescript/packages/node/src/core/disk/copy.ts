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
import { access, constants, copyFile } from 'node:fs/promises'

import type { PathSpec } from '@struktoai/mirage-core/types'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function copy(accessor: DiskAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = await resolveInside(accessor.root, src)
  const d = await resolveInside(accessor.root, dst)
  try {
    await copyFile(s, d)
  } catch (err) {
    // copyFile reports ENOENT and EACCES for either operand, so the operand
    // to blame is only knowable after the failure: probe whether the source
    // reads to tell them apart.
    let blame = dst
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') {
      const srcUnreadable = await access(s, constants.R_OK).then(
        () => false,
        () => true,
      )
      if (srcUnreadable) blame = src
    }
    throw diskError(err, blame)
  }
}
