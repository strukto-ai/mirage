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

import { invalidateAfterUnlink, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { deleteAll, gridfsPrefix, prefixQuery, rawPathOf } from './_client.ts'

export async function rmdir(accessor: GridFSAccessor, path: PathSpec): Promise<void> {
  const raw = rawPathOf(path)
  const pfx = gridfsPrefix(raw, accessor.config)
  await deleteAll(accessor, prefixQuery(pfx))
  await invalidateAfterUnlink(path)
}
