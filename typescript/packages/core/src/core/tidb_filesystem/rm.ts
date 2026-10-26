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
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { removeTree } from './client.ts'
import { kindsOf, lookupError } from './dest.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'

/**
 * Remove a subtree with one recursive delete, which drive9 resumes when it
 * answers 503 partway.
 */
export async function rmRecursive(accessor: TiDBFilesystemAccessor, path: PathSpec): Promise<void> {
  const timer = startOp()
  try {
    await removeTree(accessor, backendPath(accessor.config, path))
  } catch (exc) {
    if (!hasStatus(exc, 404)) throw exc
    const key = norm(path.mountPath)
    throw lookupError(await kindsOf(accessor, ancestors(key)), path, key)
  }
  record('rm_r', path.virtual, VFSName.TIDB_FILESYSTEM, 0, timer)
}
