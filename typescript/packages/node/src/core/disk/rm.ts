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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { rm } from 'node:fs/promises'
import { norm, rstripSlash, type PathSpec, invalidateAfterUnlink } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function rmR(accessor: DiskAccessor, path: PathSpec): Promise<void> {
  const full = resolveSafe(accessor.root, path.mountPath)
  await rm(full, { recursive: true, force: true })
  const key = norm(path.mountPath)
  const prefix = rstripSlash(key) + '/'
  for (const stale of [...accessor.attrs.keys()]) {
    if (stale === key || stale.startsWith(prefix)) accessor.attrs.delete(stale)
  }
  await invalidateAfterUnlink(path)
}
