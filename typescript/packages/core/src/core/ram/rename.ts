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
import { nowIso } from '../../utils/dates.ts'
import { norm } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { checkDestParents, lookupError } from './dest.ts'
import { invalidateAfterMove } from '../../cache/context.ts'

function moveAttrs(accessor: RAMAccessor, src: string, dst: string): void {
  const attrs = accessor.store.attrs.get(src)
  if (attrs !== undefined) {
    accessor.store.attrs.delete(src)
    accessor.store.attrs.set(dst, attrs)
  }
}

// Re-key every descendant of a renamed directory. A synthetic-directory
// store keeps subdirectories as entries of their own, so moving only the
// files leaves those behind. The phantom tree the orphans imply makes the
// old name reappear in its parent's listing and then stat as missing --
// the same shape checkDestParents refuses on the way in.
function moveSubtree(accessor: RAMAccessor, s: string, d: string): void {
  const srcPrefix = `${rstripSlash(s)}/`
  const dstPrefix = `${rstripSlash(d)}/`
  const { store } = accessor
  for (const key of [...store.dirs]) {
    if (!key.startsWith(srcPrefix)) continue
    store.dirs.delete(key)
    store.dirs.add(dstPrefix + key.slice(srcPrefix.length))
  }
  for (const key of [...store.files.keys()]) {
    if (!key.startsWith(srcPrefix)) continue
    const data = store.files.get(key)
    if (data !== undefined) {
      store.files.set(dstPrefix + key.slice(srcPrefix.length), data)
      store.files.delete(key)
    }
  }
  for (const key of [...store.modified.keys()]) {
    if (!key.startsWith(srcPrefix)) continue
    const mod = store.modified.get(key)
    if (mod !== undefined) {
      store.modified.set(dstPrefix + key.slice(srcPrefix.length), mod)
      store.modified.delete(key)
    }
  }
  for (const key of [...store.attrs.keys()]) {
    if (!key.startsWith(srcPrefix)) continue
    moveAttrs(accessor, key, dstPrefix + key.slice(srcPrefix.length))
  }
}

export async function rename(accessor: RAMAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  const now = nowIso()
  checkDestParents(accessor, dst, d)
  const srcFile = accessor.store.files.get(s)
  if (srcFile !== undefined) {
    accessor.store.files.set(d, srcFile)
    accessor.store.files.delete(s)
    accessor.store.modified.set(d, accessor.store.modified.get(s) ?? now)
    accessor.store.modified.delete(s)
    moveAttrs(accessor, s, d)
    // A file has nothing beneath it: both ends take the unlink flavor.
    await invalidateAfterMove(src, false)
    await invalidateAfterMove(dst, false)
    return Promise.resolve()
  }
  if (accessor.store.dirs.has(s)) {
    accessor.store.dirs.delete(s)
    accessor.store.dirs.add(d)
    accessor.store.modified.set(d, accessor.store.modified.get(s) ?? now)
    accessor.store.modified.delete(s)
    moveAttrs(accessor, s, d)
    moveSubtree(accessor, s, d)
    await invalidateAfterMove(src, true)
    await invalidateAfterMove(dst, true)
    return Promise.resolve()
  }
  throw lookupError(accessor, src, s)
}
