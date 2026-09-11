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

import { invalidateSubtree } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm, nowIso } from './utils.ts'
import { checkDestParents } from './dest.ts'

// Re-key every descendant of a renamed directory. A synthetic-directory
// store keeps subdirectories as members of their own set, so moving only
// the files leaves those behind. The phantom tree the orphans imply makes
// the old name reappear in its parent's listing and then stat as missing
// -- the same shape checkDestParents refuses on the way in.
async function moveSubtree(store: RedisAccessor['store'], s: string, d: string): Promise<void> {
  const prefix = rstripSlash(s) + '/'
  const dPrefix = rstripSlash(d) + '/'
  for (const key of [...(await store.listDirs())].sort(compareCodePoints)) {
    if (!key.startsWith(prefix)) continue
    const newKey = dPrefix + key.slice(prefix.length)
    const mod = await store.getModified(key)
    const attrs = await store.getAttrs(key)
    await store.removeDir(key)
    await store.delModified(key)
    await store.delAttrs(key)
    await store.addDir(newKey)
    if (mod !== null) await store.setModified(newKey, mod)
    if (Object.keys(attrs).length > 0) await store.setAttrs(newKey, attrs)
  }
  for (const key of await store.listFiles()) {
    if (!key.startsWith(prefix)) continue
    const newKey = dPrefix + key.slice(prefix.length)
    const data = await store.getFile(key)
    if (data === null) continue
    const mod = await store.getModified(key)
    const attrs = await store.getAttrs(key)
    await store.delFile(key)
    await store.delModified(key)
    await store.delAttrs(key)
    await store.setFile(newKey, data)
    if (mod !== null) await store.setModified(newKey, mod)
    if (Object.keys(attrs).length > 0) await store.setAttrs(newKey, attrs)
  }
}

export async function rename(accessor: RedisAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  const now = nowIso()
  const store = accessor.store
  await checkDestParents(store, dst, d)
  if (await store.hasFile(s)) {
    const data = await store.getFile(s)
    const mod = await store.getModified(s)
    const attrs = await store.getAttrs(s)
    if (data === null) throw enoent(src)
    await store.delFile(s)
    await store.delModified(s)
    await store.delAttrs(s)
    await store.setFile(d, data)
    await store.setModified(d, mod ?? now)
    if (Object.keys(attrs).length > 0) await store.setAttrs(d, attrs)
    await invalidateSubtree(s)
    await invalidateSubtree(d)
    return
  }
  if (await store.hasDir(s)) {
    const mod = await store.getModified(s)
    const attrs = await store.getAttrs(s)
    await store.removeDir(s)
    await store.delModified(s)
    await store.delAttrs(s)
    await store.addDir(d)
    await store.setModified(d, mod ?? now)
    if (Object.keys(attrs).length > 0) await store.setAttrs(d, attrs)
    await moveSubtree(store, s, d)
    await invalidateSubtree(s)
    await invalidateSubtree(d)
    return
  }
  throw enoent(src)
}
