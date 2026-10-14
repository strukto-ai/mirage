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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { lookupError } from './dest.ts'
import { eisdir, fsError } from '../../errors/fs.ts'
import { norm } from '../../utils/path.ts'

import { activePipe } from '../dev/device.ts'

/**
 * Remove one key. A live descriptor is the shell's to release when its
 * command ends, so unlinking one is EPERM and it stays readable (GNU:
 * `rm /dev/fd/63` is "Operation not permitted"). Mirrors Python's unlink.
 */
export async function unlink(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  if (activePipe(accessor, p) !== null) throw fsError(path, 'EPERM')
  if (accessor.store.dirs.has(p)) throw eisdir(path)
  if (!accessor.store.files.has(p)) throw lookupError(accessor, path, p)
  accessor.store.files.delete(p)
  accessor.store.modified.delete(p)
  accessor.store.attrs.delete(p)
  return Promise.resolve()
}
