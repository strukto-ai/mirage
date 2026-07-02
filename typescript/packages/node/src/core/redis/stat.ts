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

import {
  FileStat,
  FileType,
  guessType,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import { enoent } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { basename, norm } from './utils.ts'

export async function stat(
  accessor: RedisAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (await store.hasDir(p)) {
    return new FileStat({
      name: basename(p),
      modified: await store.getModified(p),
      type: FileType.DIRECTORY,
    })
  }
  if (await store.hasFile(p)) {
    const size = await store.fileLen(p)
    return new FileStat({
      name: basename(p),
      size,
      modified: await store.getModified(p),
      type: guessType(p),
    })
  }
  throw enoent(path)
}
