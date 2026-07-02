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
import { norm, nowIso } from './utils.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'
import { invalidateAfterUnlink, invalidateAfterWrite } from '../../cache/context.ts'

export async function rename(accessor: RAMAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  const now = nowIso()
  const srcFile = accessor.store.files.get(s)
  if (srcFile !== undefined) {
    accessor.store.files.set(d, srcFile)
    accessor.store.files.delete(s)
    accessor.store.modified.set(d, accessor.store.modified.get(s) ?? now)
    accessor.store.modified.delete(s)
    await invalidateAfterUnlink(src)
    await invalidateAfterWrite(dst)
    return Promise.resolve()
  }
  if (accessor.store.dirs.has(s)) {
    accessor.store.dirs.delete(s)
    accessor.store.dirs.add(d)
    accessor.store.modified.set(d, accessor.store.modified.get(s) ?? now)
    accessor.store.modified.delete(s)
    const srcPrefix = `${rstripSlash(s)}/`
    const dstPrefix = `${rstripSlash(d)}/`
    for (const key of [...accessor.store.files.keys()]) {
      if (key.startsWith(srcPrefix)) {
        const newKey = dstPrefix + key.slice(srcPrefix.length)
        const data = accessor.store.files.get(key)
        if (data !== undefined) {
          accessor.store.files.set(newKey, data)
          accessor.store.files.delete(key)
        }
      }
    }
    await invalidateAfterUnlink(src)
    await invalidateAfterWrite(dst)
    return Promise.resolve()
  }
  throw enoent(src)
}
