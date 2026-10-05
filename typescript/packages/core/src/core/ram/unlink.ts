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
import { eisdir } from '../../utils/errors.ts'
import { norm } from '../../utils/path.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'

export async function unlink(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  if (accessor.store.dirs.has(p)) throw eisdir(path)
  if (!accessor.store.files.has(p)) throw lookupError(accessor, path, p)
  accessor.store.files.delete(p)
  accessor.store.modified.delete(p)
  accessor.store.attrs.delete(p)
  await invalidateAfterUnlink(path)
  return Promise.resolve()
}
