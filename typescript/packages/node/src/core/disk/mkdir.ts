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
import { mkdir as fsMkdir } from 'node:fs/promises'
import { type PathSpec, invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core'
import { diskError } from './errors.ts'
import { resolveSafe } from './utils.ts'

export async function mkdir(
  accessor: DiskAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const full = resolveSafe(accessor.root, path.mountPath)
  if (parents) {
    await fsMkdir(full, { recursive: true })
    await invalidateAfterWrite(path)
    await invalidateAncestors(path)
    return
  }
  try {
    await fsMkdir(full)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // An existing directory stays a no-op here: cp -r mirrors a tree
    // through this op and must reuse the directories already there. The
    // rest keep the kernel's errno, restamped against the mount so only
    // the virtual path reaches a stderr line.
    if (code !== 'EEXIST') throw diskError(err, path)
  }
  await invalidateAfterWrite(path)
}
