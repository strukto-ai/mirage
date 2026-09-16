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

import type { VFSStat } from '../../vfs.ts'
import type { MontyBindingBits } from './binding.ts'

const S_IFREG = 0o100000
const S_IFDIR = 0o40000
const S_IFMT = 0o170000
const PERMISSION_BITS = 0o7777
// What monty's own StatResult reports for a directory, so a guest sees
// the same two numbers whichever host answered.
const DIR_SIZE = 4096
const DIR_LINKS = 2
const FILE_LINKS = 1

/**
 * The fields of the guest's `os.stat_result`, spelled the way CPython
 * spells them because the guest reads them by those names.
 */
export interface GuestStat {
  st_mode: number
  st_ino: number
  st_dev: number
  st_nlink: number
  st_uid: number
  st_gid: number
  st_size: number
  st_atime: number
  st_mtime: number
  st_ctime: number
}

/**
 * The row's type bits, the one rule every answer derived from a mode
 * reads.
 *
 * monty's own `StatResult` keeps whatever type bits the mode carries
 * and ORs in a default only when it carries none, so a backend
 * reporting a character device (`/dev/null`) or a symlink stays one
 * and a backend reporting permissions alone still yields a mode
 * `S_ISDIR` can mask. Deriving the type from `isDir` alone reported
 * every such row regular.
 *
 * Args:
 *   st: the mount's row for the path.
 */
function fileType(st: VFSStat): number {
  const declared = st.mode & S_IFMT
  return declared !== 0 ? declared : st.isDir ? S_IFDIR : S_IFREG
}

/** Whether the row is a regular file: python's `S_ISREG` of its mode. */
export function isRegularRow(st: VFSStat): boolean {
  return fileType(st) === S_IFREG
}

/** Whether the row is a directory: python's `S_ISDIR` of its mode. */
export function isDirRow(st: VFSStat): boolean {
  return fileType(st) === S_IFDIR
}

/**
 * One mount row as the guest's stat fields.
 *
 * The numbers are monty's own `StatResult.file_stat` / `dir_stat`
 * rules, replicated rather than imported because the JS package
 * exports no `StatResult`: the type bits come from the row, the
 * permission bits from its mode, and a directory reports 4096 bytes
 * and two links whatever the backend said. Keeping the two hosts on
 * one rule is the whole point — `python/mirage/runtime/python/monty/
 * stat.py` reaches the same numbers by calling the constructors.
 *
 * Args:
 *   st: the mount's row for the path.
 */
export function statFields(st: VFSStat): GuestStat {
  const type = fileType(st)
  // Seconds, as CPython reports them; 0 is the door's spelling of "no
  // stamp", and it stays 0 rather than becoming the host clock.
  const stamp = st.mtimeMs / 1000
  return {
    st_mode: type | (st.mode & PERMISSION_BITS),
    st_ino: 0,
    st_dev: 0,
    st_nlink: st.isDir ? DIR_LINKS : FILE_LINKS,
    st_uid: 0,
    st_gid: 0,
    st_size: st.isDir ? DIR_SIZE : st.size,
    st_atime: stamp,
    st_mtime: stamp,
    st_ctime: stamp,
  }
}

/**
 * The guest-side `os.stat_result` for one row.
 *
 * Wrapped in the binding's `ClassInstance` rather than returned bare:
 * a plain object converts structurally and arrives as a dict, so
 * `st.st_size` raised AttributeError. The wrapper (new in
 * @pydantic/monty 0.0.22) sends the object as a class instance with
 * its own name, so attribute access and `repr` both read as CPython's.
 * The sequence half of a real `stat_result` does not cross: the guest
 * cannot subscript, iterate or take `len` of the answer, because the
 * wire has no namedtuple shape and a wrapper exposes no dunders. That
 * is the one remaining divergence from the python host, which hands
 * monty a real `StatResult`.
 *
 * Args:
 *   bits: the loaded binding's door pieces.
 *   st: the mount's row for the path.
 */
export function statResult(bits: MontyBindingBits, st: VFSStat): object {
  return new bits.ClassInstance(statFields(st), { name: 'stat_result', eagerAttrs: 'all' })
}
