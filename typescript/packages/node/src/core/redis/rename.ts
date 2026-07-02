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

import { type PathSpec, invalidateAfterUnlink, invalidateAfterWrite } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm, nowIso } from './utils.ts'
import { rstripSlash } from '@struktoai/mirage-core'

export async function rename(accessor: RedisAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  const now = nowIso()
  const store = accessor.store
  if (await store.hasFile(s)) {
    const data = await store.getFile(s)
    const mod = await store.getModified(s)
    const attrs = await store.getAttrs(s)
    if (data === null) throw new Error(`file not found: ${s}`)
    await store.delFile(s)
    await store.delModified(s)
    await store.delAttrs(s)
    await store.setFile(d, data)
    await store.setModified(d, mod ?? now)
    if (Object.keys(attrs).length > 0) await store.setAttrs(d, attrs)
    await invalidateAfterUnlink(s)
    await invalidateAfterWrite(d)
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
    const prefix = rstripSlash(s) + '/'
    const dPrefix = rstripSlash(d) + '/'
    const files = await store.listFiles()
    for (const key of files) {
      if (key.startsWith(prefix)) {
        const newKey = dPrefix + key.slice(prefix.length)
        const data = await store.getFile(key)
        if (data === null) continue
        const subAttrs = await store.getAttrs(key)
        await store.delFile(key)
        await store.delAttrs(key)
        await store.setFile(newKey, data)
        if (Object.keys(subAttrs).length > 0) await store.setAttrs(newKey, subAttrs)
      }
    }
    await invalidateAfterUnlink(s)
    await invalidateAfterWrite(d)
    return
  }
  throw new Error(`file not found: ${s}`)
}
