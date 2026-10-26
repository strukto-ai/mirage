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
import { eexist } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { makeDirectory } from './client.ts'
import { checkMkdirTarget, kindsOf } from './dest.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'

/**
 * Make a directory; drive9 makes any missing parent with it, which plain
 * mkdir refuses before it asks.
 */
export async function mkdir(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = norm(path.mountPath)
  const kinds = await kindsOf(accessor, [...ancestors(key), key])
  if (checkMkdirTarget(kinds, path, key, parents)) return
  try {
    await makeDirectory(accessor, backendPath(accessor.config, path))
  } catch (exc) {
    if (hasStatus(exc, 409)) throw eexist(path)
    throw exc
  }
}
