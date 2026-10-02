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

import type { BoxAccessor } from '../../accessor/box.ts'
import { settleAfterWrite, writeGeneration } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { uploadFileVersion, uploadNewFile } from './api.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'

export async function write(
  accessor: BoxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) throw eisdir(path.virtual)
  const tm = accessor.tokenManager
  const existing = await resolveItem(accessor, parts)
  let generation: number | null
  if (existing !== null && existing.type === 'file') {
    // Overwrite uploads a new version under the same id, keeping Box's own
    // name so a box-native file isn't renamed with the vfs suffix.
    generation = writeGeneration()
    await uploadFileVersion(tm, existing.id, existing.name, data)
  } else {
    const parentId = await resolveParentId(accessor, parts)
    if (parentId === null) throw enoent(path.virtual)
    generation = writeGeneration()
    await uploadNewFile(tm, parentId, parts[parts.length - 1] ?? '', data)
  }
  await settleAfterWrite(path, data, null, generation)
}
