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
import { rename as fsRename } from 'node:fs/promises'
import {
  enoent,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  norm,
  rstripSlash,
  type PathSpec,
} from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function rename(accessor: DiskAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = resolveSafe(accessor.root, src.mountPath)
  const d = resolveSafe(accessor.root, dst.mountPath)
  try {
    await fsRename(s, d)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(src)
    }
    throw err
  }
  const sKey = norm(src.mountPath)
  const dKey = norm(dst.mountPath)
  const prefix = rstripSlash(sKey) + '/'
  for (const key of [...accessor.attrs.keys()]) {
    if (key === sKey) {
      const entry = accessor.attrs.get(key)
      accessor.attrs.delete(key)
      if (entry !== undefined) accessor.attrs.set(dKey, entry)
    } else if (key.startsWith(prefix)) {
      const entry = accessor.attrs.get(key)
      accessor.attrs.delete(key)
      if (entry !== undefined) {
        accessor.attrs.set(rstripSlash(dKey) + '/' + key.slice(prefix.length), entry)
      }
    }
  }
  await invalidateAfterUnlink(src)
  await invalidateAfterWrite(dst)
}
