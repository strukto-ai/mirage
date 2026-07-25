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

import { invalidateAfterWrite, invalidateAncestors, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { gridfsPrefix, rawPathOf } from './_client.ts'
import { uploadBytes } from './write.ts'

export async function mkdir(
  accessor: GridFSAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  // GridFS has no real directories; parents are implicit. A zero-byte
  // "key/" marker doc makes the empty directory visible.
  const raw = rawPathOf(path)
  const pfx = gridfsPrefix(raw, accessor.config)
  if (pfx === '') return
  await uploadBytes(accessor, pfx, new Uint8Array(0))
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
