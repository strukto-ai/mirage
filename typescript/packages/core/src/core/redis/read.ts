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

import { record, recordStream, startOp } from '../../observe/context.ts'
import { VFSName } from '../../types.ts'
import type { PathSpec } from '../../types.ts'
import { lookupError } from './dest.ts'
import { eisdir } from '../../errors/fs.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from '../../utils/path.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Redis accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: RedisAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const timer = startOp()
  const p = norm(path.mountPath)
  const data =
    offset !== 0 || size !== null
      ? await accessor.store.getFileRange(p, offset, size)
      : await accessor.store.getFile(p)
  if (data === null) {
    if (await accessor.store.hasDir(p)) throw eisdir(path)
    throw await lookupError(accessor.store, path, p)
  }
  record('read', path.virtual, VFSName.REDIS, data.byteLength, timer)
  return data
}

/**
 * Several whole files by virtual path, in one round trip whatever their
 * number (`RedisStoreLike.getFiles`): one that is absent, empty or no file,
 * one longer than `limit`, and one that does not fit in `room` beside the
 * files read before it is left out for its own read to meet. A path named
 * twice is read once. Each file read is recorded as a whole streamed read
 * records it. Mirrors Python's `read_many`.
 *
 * Args:
 *   accessor: Redis accessor.
 *   paths: the files, all on this mount.
 *   limit: the most bytes worth fetching for one file.
 *   room: the most bytes the files read may come to together, null for no
 *     bound.
 */
export async function readMany(
  accessor: RedisAccessor,
  paths: readonly PathSpec[],
  limit: number,
  room: number | null = null,
): Promise<Map<string, Uint8Array>> {
  const files = [...new Map(paths.map((p) => [p.virtual, p])).values()]
  const found = await accessor.store.getFiles(
    files.map((p) => norm(p.mountPath)),
    limit,
    room,
  )
  const read = new Map<string, Uint8Array>()
  files.forEach((spec, i) => {
    const data = found[i] ?? null
    if (data === null) return
    const rec = recordStream('read', spec.virtual, VFSName.REDIS)
    if (rec !== null) {
      rec.bytes = data.byteLength
      rec.complete = true
    }
    read.set(spec.virtual, data)
  })
  return read
}
