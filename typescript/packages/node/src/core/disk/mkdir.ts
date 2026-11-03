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

import { classify } from '@struktoai/mirage-core/errors/classify'
import { posixErrno } from '@struktoai/mirage-core/errors/posix'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { lstat, mkdir as fsMkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { norm } from '@struktoai/mirage-core/utils/path'
import { mkdirComponentError } from './dest.ts'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

async function firstMissing(path: string): Promise<string | null> {
  let missing: string | null = null
  while (!(await exists(path))) {
    missing = path
    if (dirname(path) === path) break
    path = dirname(path)
  }
  return missing
}

export async function mkdir(
  accessor: DiskAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const root = accessor.root
  const full = await resolveInside(root, path)
  const timer = startOp()
  if (parents) {
    const missing = await firstMissing(full)
    let failure: unknown = null
    try {
      await fsMkdir(full, { recursive: true })
    } catch (err) {
      failure = err
      // The kernel names the whole path; GNU names the component it tripped
      // on, so the chain is walked only now that it is known to be broken.
      const named =
        (err as NodeJS.ErrnoException).code === 'ENOTDIR'
          ? await mkdirComponentError(root, path, norm(path.mountPath))
          : null
      throw named ?? diskError(err, path)
    } finally {
      // Also when it threw: the chain may have made its first directories
      // before a later one failed.
      const changed = failure === null || (missing !== null && (await exists(missing)))
      const condition = classify(failure)
      record('mkdir', path.virtual, VFSName.DISK, 0, timer, {
        status: failure === null ? 'ok' : changed ? 'partial' : 'failed',
        changed,
        errno: condition === null ? null : posixErrno(condition),
      })
    }
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
  record('mkdir', path.virtual, VFSName.DISK, 0, timer)
}
