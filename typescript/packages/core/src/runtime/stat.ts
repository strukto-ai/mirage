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

import { BLKSIZE, BLOCK_UNIT, ident } from '../utils/stat_view.ts'
import type { VFSStat } from './types.ts'

/**
 * One path's stat as a POSIX kernel fills it, from a mount's row: what
 * every runtime that answers a guest's stat (the host entry points,
 * QuickJS) reads and spells in its own shape, so a link count, an owner,
 * a block count or an inode is the same number whichever one is asked.
 * `nlink` is 2 for a directory and 1 otherwise; the access time is the
 * modification time when the row has none, and the change time always
 * is. Mirrors Python's `runtime/stat.PosixStat`.
 */
export interface PosixStat {
  readonly mode: number
  readonly ino: number
  readonly dev: number
  readonly nlink: number
  readonly uid: number
  readonly gid: number
  readonly rdev: number
  readonly size: number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly blksize: number
  readonly blocks: number
}

/**
 * The POSIX stat a runtime reports for one mount row. `uid` and `gid`
 * are what a row without an owner reports (a host process's own, 0 in a
 * sandbox), and `unknownMs` what an unknown modification time reads as.
 * Mirrors Python's `posix_stat`.
 */
export function posixStat(
  row: VFSStat,
  path: string,
  prefix: string,
  fallback: { uid?: number; gid?: number; unknownMs?: number } = {},
): PosixStat {
  const mtime = row.mtimeMs ?? fallback.unknownMs ?? 0
  return {
    mode: row.mode,
    ino: ident(path),
    dev: ident(prefix),
    nlink: row.isDir ? 2 : 1,
    uid: row.uid ?? fallback.uid ?? 0,
    gid: row.gid ?? fallback.gid ?? 0,
    rdev: row.rdev ?? 0,
    size: row.size,
    atimeMs: row.atimeMs ?? mtime,
    mtimeMs: mtime,
    ctimeMs: mtime,
    blksize: BLKSIZE,
    blocks: Math.ceil(row.size / BLOCK_UNIT),
  }
}
