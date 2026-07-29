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
import {
  type PathSpec,
  invalidateAfterWrite,
  invalidateAncestors,
  norm,
} from '@struktoai/mirage-core'
import { mkdirComponentError } from './dest.ts'
import { diskError } from './errors.ts'
import { resolveSafe } from './utils.ts'

export async function mkdir(
  accessor: DiskAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const root = accessor.root
  const full = resolveSafe(root, path.mountPath)
  if (parents) {
    try {
      await fsMkdir(full, { recursive: true })
    } catch (err) {
      // The kernel names the whole path; GNU names the component it tripped
      // on, so the chain is walked only now that it is known to be broken.
      const named =
        (err as NodeJS.ErrnoException).code === 'ENOTDIR'
          ? await mkdirComponentError(root, path, norm(path.mountPath))
          : null
      throw named ?? diskError(err, path)
    }
    await invalidateAfterWrite(path)
    await invalidateAncestors(path)
    return
  }
  // An existing target is EEXIST, not success: only -p is idempotent (GNU).
  // Every internal caller that mirrors a tree through this op (cp -r) probes
  // with isDirectory first, so it never reaches this path for a directory it
  // meant to reuse.
  try {
    await fsMkdir(full)
  } catch (err) {
    throw diskError(err, path)
  }
  await invalidateAfterWrite(path)
}
