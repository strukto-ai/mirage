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

import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { enotempty } from '../../errors/fs.ts'
import { lookupError } from './dest.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { norm } from '../../utils/path.ts'

/**
 * Remove an empty directory, mirroring the python backend.
 *
 * The store is flat, so dropping the directory key is not the whole of
 * rmdir: the children are keyed independently and survive it. Without the
 * two checks below, `rmdir` on a populated directory reported success and
 * left every child addressable but unreachable -- `readdir` then raised,
 * because the directory they hang off had been erased.
 */
export async function rmdir(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (!store.dirs.has(p)) throw lookupError(accessor, path, p)
  const prefix = `${rstripSlash(p)}/`
  const keys = [...store.files.keys(), ...store.dirs]
  if (keys.some((k) => k !== p && k.startsWith(prefix))) throw enotempty(path)
  store.dirs.delete(p)
  store.modified.delete(p)
  await invalidateAfterUnlink(path)
}
