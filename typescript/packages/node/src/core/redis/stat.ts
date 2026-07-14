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

function decodeAttrs(raw: Record<string, string>): {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
} {
  const out: { mode?: number; uid?: number | string; gid?: number | string; atime?: string } = {}
  if (raw.mode !== undefined) out.mode = parseInt(raw.mode, 10)
  for (const key of ['uid', 'gid'] as const) {
    const val = raw[key]
    if (val !== undefined) out[key] = /^\d+$/.test(val) ? parseInt(val, 10) : val
  }
  if (raw.atime !== undefined) out.atime = raw.atime
  return out
}

export async function stat(
  accessor: RedisAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (await store.hasDir(p)) {
    const attrs = decodeAttrs(await store.getAttrs(p))
    return new FileStat({
      name: basename(p),
      modified: await store.getModified(p),
      type: FileType.DIRECTORY,
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
    })
  }
  if (await store.hasFile(p)) {
    const size = await store.fileLen(p)
    const attrs = decodeAttrs(await store.getAttrs(p))
    return new FileStat({
      name: basename(p),
      size,
      modified: await store.getModified(p),
      type: guessType(p),
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
    })
  }
  throw enoent(path)
}
