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

import { FileStat, FileType } from '../../types.ts'
import type { PathSpec } from '../../types.ts'
import { lookupError } from './dest.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import type { RedisStoreLike } from '../../vfs/redis/store.ts'
import { gnuBasename, norm } from '../../utils/path.ts'

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

// The stat of the normalized key `p` from what the store holds for it.
// Mirrors Python's `_from_fields`.
function fromFields(
  p: string,
  isDir: boolean,
  raw: Record<string, string>,
  size: number | null,
  modified: string | null,
): FileStat {
  const attrs = decodeAttrs(raw)
  if (isDir) {
    return new FileStat({
      name: gnuBasename(p),
      modified,
      type: FileType.DIRECTORY,
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
    })
  }
  return new FileStat({
    name: gnuBasename(p),
    size,
    modified,
    type: FileType.FILE,
    content: contentTypeForPath(p),
    mode: attrs.mode ?? null,
    uid: attrs.uid ?? null,
    gid: attrs.gid ?? null,
    atime: attrs.atime ?? null,
  })
}

/**
 * What `stat` answers for the normalized key `p` the store holds. Mirrors
 * Python's `key_stat`.
 */
export async function keyStat(store: RedisStoreLike, p: string, isDir: boolean): Promise<FileStat> {
  const raw = await store.getAttrs(p)
  const size = isDir ? null : await store.fileLen(p)
  return fromFields(p, isDir, raw, size, await store.getModified(p))
}

/** `keyStat` for many keys, in one pipeline. Mirrors Python's `key_stats`. */
export async function keyStats(
  store: RedisStoreLike,
  keys: readonly [string, boolean][],
): Promise<FileStat[]> {
  const fields = await store.statMany(keys)
  return keys.map(([p, isDir], i) => {
    const [raw, size, modified] = fields[i] ?? [{}, null, null]
    return fromFields(p, isDir, raw, size, modified)
  })
}

export async function stat(accessor: RedisAccessor, path: PathSpec): Promise<FileStat> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (await store.hasDir(p)) return keyStat(store, p, true)
  if (await store.hasFile(p)) return keyStat(store, p, false)
  throw await lookupError(store, path, p)
}
