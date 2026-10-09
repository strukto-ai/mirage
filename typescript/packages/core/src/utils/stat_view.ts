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

import { FileType, type FileStat } from '../types.ts'
import { isoTimestamp } from './dates.ts'

// The one spelling of "a directory looks like drwxr-xr-x and a file
// like -rw-r--r--" for every stat translator (FUSE attrs, guest
// st_mode); mirrors mirage/utils/stat_view.py.
const S_IFDIR = 0o040000
const S_IFCHR = 0o020000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000
export const CHAR_MODE = S_IFCHR | 0o666
export const DIR_MODE = S_IFDIR | 0o755
export const FILE_MODE = S_IFREG | 0o644
// A link is always lrwxrwxrwx: the bits on a symlink are not consulted
// by any POSIX system, so this is the one mode every translator reports
// for one (the FUSE attr fold, find's -type l row, a guest's lstat).
export const LINK_MODE = S_IFLNK | 0o777
// A directory is one ext4 block, the st_size GNU tools show for one,
// whatever aggregate a backend reports; ls, stat, find and FUSE all
// report this, so find -size agrees with what the listing shows.
export const DIR_SIZE = 4096

/**
 * A FileStat's mtime as epoch milliseconds, null when unknown.
 *
 * Delegates to `isoTimestamp` rather than re-parsing, which is the
 * whole point: an offset-less stamp is read as UTC so every translator
 * (the FUSE attr fold, the runtime bridge, python's twins) answers the
 * same epoch, instead of drifting by the host's UTC offset the way a
 * bare `Date.parse`/`new Date` does. Null (missing or unparseable
 * stamp) is distinct from 0, which is the real answer for
 * 1970-01-01T00:00:00Z; a wire with no validity channel collapses the
 * two at its own boundary.
 */
export function mtimeMs(st: FileStat): number | null {
  const seconds = isoTimestamp(st.modified)
  return seconds === null ? null : seconds * 1000
}

/** A FileStat's atime as epoch milliseconds, null when unknown. */
export function atimeMs(st: FileStat): number | null {
  const seconds = isoTimestamp(st.atime)
  return seconds === null ? null : seconds * 1000
}

/** Whether a FileStat describes a directory. */
export function isDir(st: FileStat): boolean {
  return st.type === FileType.DIRECTORY
}

/** Whether a FileStat describes a symlink. */
export function isLink(st: FileStat): boolean {
  return st.type === FileType.SYMLINK
}

/** Whether a FileStat describes a character device. */
export function isCharDevice(st: FileStat): boolean {
  return st.type === FileType.CHAR_DEVICE
}

/** Encode a character device's logical major:minor for guest stat. */
export function deviceRdev(st: FileStat): number {
  const values = st.extra.device_numbers
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    !values.every((value) => Number.isInteger(value))
  ) {
    return 0
  }
  return (Number(values[0]) << 8) | Number(values[1])
}

/**
 * The st_mode a stat consumer should report for one FileStat.
 *
 * The type bits come from the entry's kind and the permission bits from
 * the namespace overlay when a chmod put one there, which is what makes
 * a metadata write visible to a guest and to a mount alike. A backend
 * that reports no mode keeps the default rw-r--r-- / rwxr-xr-x pair;
 * there are no permissions to read on an object store.
 *
 * A link is the exception in both halves: its type bits are S_IFLNK and
 * its permission bits are always 0777, because no POSIX system consults
 * the bits on a symlink. An overlay mode a `chmod -h` wrote is
 * therefore not reported here (ownership is, since `chown -h` does
 * change what `ls -l` shows). Mirrors python's posix_mode.
 */
export function posixMode(st: FileStat): number {
  if (isLink(st)) return LINK_MODE
  const base = isCharDevice(st) ? CHAR_MODE : isDir(st) ? DIR_MODE : FILE_MODE
  if (st.mode === null) return base
  return (base & ~0o7777) | (st.mode & 0o7777)
}

/**
 * The byte size a stat consumer should report, 0 when unknown.
 *
 * A directory is always `DIR_SIZE`, whatever aggregate a backend put in
 * `size` (Graph folders report a subtree total there); an unknown file
 * size is 0 and rides the unknown-size machinery above.
 */
export function contentSize(st: FileStat): number {
  if (isDir(st)) return DIR_SIZE
  return st.size ?? 0
}
