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

import { classify } from '../errors/index.ts'
import { eexist, eisdir, enoent } from '../errors/fs.ts'
import type { OpenMode } from './handles/mode.ts'
import type { VFSEntry, VFSStat } from './types.ts'

/**
 * What an open asks of the filesystem it lands on. The file door
 * (`RuntimeFiles`) answers it for the mounts.
 */
export interface OpenSurface {
  statOrNull(path: string, nofollow?: boolean): Promise<VFSStat | null>
  listingOrNull(path: string): Promise<VFSEntry[] | null>
  create(path: string): Promise<void>
  truncate(path: string): Promise<void>
}

/**
 * Apply an open's effect, before any byte moves.
 *
 * One rule for every open, however it is spelled (a mode string,
 * preview1 oflags): an exclusive create refuses what exists, a
 * directory refuses, a missing path is created when the mode creates
 * and refused when it does not, and a truncating mode empties what
 * exists. The effect lands at open because CPython's `open('w')` leaves
 * an empty file behind even when nothing is written; a bare open and
 * close never flushes. Each caller spells the refusals in its own
 * dialect (an errno, CPython's wording).
 *
 * Returns the file's row when its content survives the open (a read or
 * an append), null when it starts empty (created or truncated). Throws
 * EEXIST for an exclusive create that found the path, a dangling link
 * or a listed directory included, EISDIR for a directory, one a mount
 * lists but has no row for included, and ENOENT for a missing path the
 * mode does not create.
 *
 * Args:
 *   surface: the filesystem the open lands on.
 *   path: absolute virtual path.
 *   mode: what the open asked for.
 */
export async function applyOpen(
  surface: OpenSurface,
  path: string,
  mode: OpenMode,
): Promise<VFSStat | null> {
  // An exclusive create follows no link (POSIX O_CREAT|O_EXCL), so a
  // dangling one is a name that is there. A path with no row may still
  // be a directory the mount lists, and a create there would put a file
  // at a directory's name.
  const row = await surface.statOrNull(path, mode.exclusive)
  const listed = row !== null ? row.isDir : (await surface.listingOrNull(path)) !== null
  if (mode.exclusive && (row !== null || listed)) throw eexist(path)
  if (listed) throw eisdir(path)
  if (row === null) {
    if (!mode.create) throw enoent(path)
    await surface.create(path)
    return null
  }
  if (mode.truncate) {
    try {
      await surface.truncate(path)
    } catch (err) {
      if (classify(err) !== 'ENOTSUP') throw err
      // A mount with no truncate (hf buckets, databricks volumes) still
      // empties the file through an empty create, which is the effect the
      // open asked for.
      await surface.create(path)
    }
    return null
  }
  return row
}
