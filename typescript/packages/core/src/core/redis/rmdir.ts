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

import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from './utils.ts'

/**
 * Remove an empty directory, mirroring the python backend.
 *
 * Both refusals go through the shared error helpers so they carry an
 * errno. They used to be bare `Error`s whose only signal was the wording,
 * which left the FUSE adapter sniffing message text to recover ENOTEMPTY
 * and left every other caller -- `ws.fs`, the sandbox runtimes -- with an
 * error `classify` could not name at all. A missing directory is ENOENT,
 * not ENOTDIR: the path resolves to nothing, which is also what python
 * reports here.
 */
export async function rmdir(accessor: RedisAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (!(await store.hasDir(p))) throw enoent(path)
  const prefix = `${rstripSlash(p)}/`
  const files = await store.listFiles()
  const dirs = await store.listDirs()
  const candidates = [...files, ...dirs]
  if (candidates.some((k) => k !== p && k.startsWith(prefix))) throw enotempty(path)
  await store.removeDir(p)
  await invalidateAfterUnlink(path)
}
