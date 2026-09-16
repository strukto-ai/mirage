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

import type { FileStat } from '@struktoai/mirage-core/types'
import { DIR_MODE, FILE_MODE, LINK_MODE, mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import type { MountAttrs } from './types.ts'

/**
 * The row a directory reports before any overlay.
 *
 * @param uid the mounting user
 * @param gid the mounting group
 * @param now the mount's construction time, used for every entry the
 *   backend cannot date
 */
export function dirStat(uid: number, gid: number, now: Date): MountAttrs {
  return { mtime: now, atime: now, ctime: now, nlink: 2, size: 0, mode: DIR_MODE, uid, gid }
}

/**
 * The row a regular file reports before any overlay.
 *
 * @param size byte length a client should see
 * @param uid the mounting user
 * @param gid the mounting group
 * @param now the mount's construction time
 */
export function fileStat(size: number, uid: number, gid: number, now: Date): MountAttrs {
  return { mtime: now, atime: now, ctime: now, nlink: 1, size, mode: FILE_MODE, uid, gid }
}

/**
 * Fold the backend's merged stat onto a base row.
 *
 * The workspace stat already carries the namespace overlay (chmod bits,
 * chown ids, touched mtime), so honoring these fields here is what makes
 * metadata ops visible through a mount. String uid/gid (names) are
 * skipped: the kernel wants numeric ids and there is no user db to map
 * against.
 *
 * @param entry base row from {@link dirStat} or {@link fileStat}
 * @param s the merged stat the ops facade returned
 */
export function applyStatAttrs(entry: MountAttrs, s: FileStat): MountAttrs {
  if (s.mode !== null) {
    entry.mode = (entry.mode & ~0o7777) | (s.mode & 0o7777)
  }
  if (typeof s.uid === 'number') entry.uid = s.uid
  if (typeof s.gid === 'number') entry.gid = s.gid
  if (s.modified !== null) {
    // One translator per language: the naive-stamp-is-UTC rule lives in
    // core's stat view, never re-parsed here with a bare Date. Null
    // means the stamp did not parse; epoch zero is a real time and lands.
    const ms = mtimeMs(s)
    if (ms !== null) {
      entry.mtime = new Date(ms)
      entry.ctime = new Date(ms)
    }
  }
  return entry
}

/**
 * The row a namespace link reports, from its own node row.
 *
 * Built from the target string alone, every link over a mount answered
 * the mount's construction time and the mounting user, so what
 * `chown -h` and `touch -h` wrote was invisible through the kernel. The
 * row passed here is the one the door answers a no-follow stat with.
 * Size stays the displayable target's length (what this mount's readlink
 * returns), and the mode is always lrwxrwxrwx: a symlink's permission
 * bits are not consulted by any POSIX system.
 *
 * @param target the target as this mount presents it
 * @param row the link's own node row, when the namespace holds one
 * @param uid the mounting user
 * @param gid the mounting group
 * @param now the mount's construction time
 */
export function linkStat(
  target: string,
  row: FileStat | null,
  uid: number,
  gid: number,
  now: Date,
): MountAttrs {
  const entry = fileStat(new TextEncoder().encode(target).byteLength, uid, gid, now)
  if (row !== null) applyStatAttrs(entry, row)
  entry.mode = LINK_MODE
  return entry
}
