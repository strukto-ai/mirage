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

import {
  enoent,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { deleteAll, filesColl, gridfsKey, latestFile, rawPathOf } from './_client.ts'

export async function rename(
  accessor: GridFSAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  // Server-side: retag every revision's filename instead of copying
  // bytes, so the whole revision history moves with the file.
  const srcKey = gridfsKey(rawPathOf(src), accessor.config)
  const dstKey = gridfsKey(rawPathOf(dst), accessor.config)
  if ((await latestFile(accessor, srcKey)) === null) {
    throw enoent(src)
  }
  await deleteAll(accessor, { filename: dstKey })
  const files = await filesColl(accessor)
  await files.updateMany({ filename: srcKey }, { $set: { filename: dstKey } })
  await invalidateAfterWrite(dst)
  await invalidateAfterUnlink(src)
}
