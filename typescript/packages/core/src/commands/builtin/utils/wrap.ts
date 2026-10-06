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

import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { MountView } from '../../../ops/types.ts'
import { FileStat, FileType, type PathSpec } from '../../../types.ts'
import { isMissError } from '../../../errors/fs.ts'
import { operandName } from './operands.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// Synthesize a streaming read from a whole-file read, for backends with
// no native streaming (mirrors python's utils/wrap.stream_from_bytes).
export async function* streamFromBytes<A>(
  read: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<Uint8Array>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}

/**
 * Wrap a walker's readdir so a mount parent lists as empty, not absent.
 *
 * A directory that exists only because mounts sit under it has no backend
 * to list it, so the readdir throws and a recursive command reports the
 * operand missing even as the fan-out searches the mounts below it and
 * prints hits. Empty is the honest answer for the primary backend: the
 * directory is there, and it owns nothing in it.
 *
 * Empty rather than the mount names, because the fan-out already runs the
 * command once per descendant mount and concatenates. Listing them here
 * would search each one twice.
 *
 * The visible descendants, not every descendant. Answering at all tells
 * the session the directory is there, and a directory that exists only
 * because of a mount it may not be told about is a directory it may not be
 * told about either: a hidden mount under an otherwise absent parent has
 * to keep reading as absence, the same way the mount itself does.
 *
 * Only for an absence, which is why the catch is `isMissError` and not the
 * walk's own wider set: a directory the backend refused with EACCES or
 * ENOTSUP is there and holds data this run cannot read, and calling it
 * empty would let `grep -r` print the descendant mount's hits and exit 0
 * while silently omitting it. A refusal that is not absence keeps
 * propagating and gets reported.
 *
 * A directory a mount below this one serves lists as empty too, whatever
 * the backend holds there: the mount shadows those keys, as a kernel mount
 * does, and the fan-out walks it in a run of its own. `home` is the prefix
 * of the mount the readdir is bound to.
 */
export function mountParentReaddir(
  readdir: (p: string) => Promise<string[]>,
  mounts: MountView | null | undefined,
  home: string,
): (p: string) => Promise<string[]> {
  if (mounts === undefined || mounts === null) return readdir
  return async (p: string) => {
    const below = mounts.descendants(home === '' ? '/' : home)
    if (below.some((root) => p === root || p.startsWith(rstripSlash(root) + '/'))) return []
    try {
      return await readdir(p)
    } catch (e) {
      if (!isMissError(e)) throw e
      if (mounts.visibleDescendants(p).length === 0) throw e
      return []
    }
  }
}

/**
 * Wrap a walker's stat so a mount parent reports as a directory.
 *
 * The twin of `mountParentReaddir`, and the reason a recursive search over
 * `/repos` reported it missing while still printing hits from
 * `/repos/alpha`: the operand was statted before it was walked, the
 * primary backend has no such path, and the miss was reported as absence.
 *
 * The mount table decides, not the dispatcher. A dispatched stat would
 * answer for paths inside the descendant mounts too, which is exactly what
 * the primary run must not see: the fan-out searches each of them
 * separately, so claiming their entries here would search them twice.
 *
 * Visible descendants only, because a row is a disclosure: the parent of a
 * mount this session may not be told about stays absent, which is what
 * every other verb already answers there.
 *
 * An absence only, the same as its readdir twin: a backend that refused the
 * path rather than not having it is reporting something the run must not
 * paper over with a synthesized row.
 */
export function mountParentStat(
  stat: (p: string) => Promise<FileStat>,
  mounts?: MountView | null,
): (p: string) => Promise<FileStat> {
  if (mounts === undefined || mounts === null) return stat
  return async (p: string) => {
    try {
      return await stat(p)
    } catch (e) {
      if (!isMissError(e)) throw e
      if (mounts.visibleDescendants(p).length === 0) throw e
      return new FileStat({ name: operandName(p), type: FileType.DIRECTORY })
    }
  }
}
