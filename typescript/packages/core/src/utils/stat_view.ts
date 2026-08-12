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
const S_IFREG = 0o100000
export const DIR_MODE = S_IFDIR | 0o755
export const FILE_MODE = S_IFREG | 0o644

/**
 * A FileStat's mtime as epoch milliseconds, 0 when unknown.
 *
 * Delegates to `isoTimestamp` rather than re-parsing, which is the
 * whole point: an offset-less stamp is read as UTC so every translator
 * (the FUSE attr fold, the runtime bridge, python's twins) answers the
 * same epoch, instead of drifting by the host's UTC offset the way a
 * bare `Date.parse`/`new Date` does.
 */
export function mtimeMs(st: FileStat): number {
  const seconds = isoTimestamp(st.modified)
  return seconds === null ? 0 : seconds * 1000
}

/** Whether a FileStat describes a directory. */
export function isDir(st: FileStat): boolean {
  return st.type === FileType.DIRECTORY
}

/**
 * The byte size a stat consumer should report, 0 when unknown.
 *
 * A directory is always 0, whatever aggregate a backend put in `size`
 * (Graph folders report a subtree total there); an unknown file size
 * is 0 and rides the unknown-size machinery above.
 */
export function contentSize(st: FileStat): number {
  if (isDir(st)) return 0
  return st.size ?? 0
}
