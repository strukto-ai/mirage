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

import type { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from '../../utils/path.ts'
import { enotempty } from '../../errors/fs.ts'
import { keepLeft } from './dest.ts'

export async function rmR(accessor: RedisAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  const prefix = rstripSlash(p) + '/'
  const files = await store.listFiles()
  for (const key of files) {
    if (key === p || key.startsWith(prefix)) {
      await store.delFile(key)
      await store.delModified(key)
      await store.delAttrs(key)
    }
  }
  const removed = [...(await store.listDirs())].filter((k) => k === p || k.startsWith(prefix))
  for (const key of removed) await store.removeDir(key)
  // The listings ran once, so a key written under the path since stayed, and
  // the directories that hold it keep their metadata.
  const kept = await keepLeft(store, p)
  for (const key of removed) {
    if (kept.has(key)) continue
    await store.delModified(key)
    await store.delAttrs(key)
  }
  if (kept.size > 0) throw enotempty(path)
}
