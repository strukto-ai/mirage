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

import { constants } from 'node:fs'
import type { PosixStat } from '@struktoai/mirage-core/runtime/stat'

const { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFLNK } = constants

/** A stamp in nanoseconds, as node's BigIntStats spells one. */
function ns(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n
}

/**
 * One node `Stats`, or `BigIntStats` for `bigint`, from the stat the
 * shared rule computed for a path: the twin of python's `stat_result`.
 *
 * @param st - the stat every runtime shares for the path.
 * @param bigint - answer every number as a bigint, plus the stamps in ns.
 */
export function stats(st: PosixStat, bigint: boolean): unknown {
  const kind = st.mode & S_IFMT
  const mtime = new Date(st.mtimeMs)
  const atime = new Date(st.atimeMs)
  const kinds = {
    isFile: () => kind === S_IFREG,
    isDirectory: () => kind === S_IFDIR,
    isBlockDevice: () => false,
    isCharacterDevice: () => kind === S_IFCHR,
    isSymbolicLink: () => kind === S_IFLNK,
    isFIFO: () => false,
    isSocket: () => false,
  }
  const dates = { atime, mtime, ctime: mtime, birthtime: mtime }
  const fields: Record<string, number> = {
    dev: st.dev,
    ino: st.ino,
    mode: st.mode,
    nlink: st.nlink,
    uid: st.uid,
    gid: st.gid,
    rdev: st.rdev,
    size: st.size,
    blksize: st.blksize,
    blocks: st.blocks,
    atimeMs: st.atimeMs,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    birthtimeMs: st.mtimeMs,
  }
  if (!bigint) return { ...kinds, ...fields, ...dates }
  const big = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, BigInt(Math.trunc(v))]))
  return {
    ...kinds,
    ...big,
    atimeNs: ns(atime),
    mtimeNs: ns(mtime),
    ctimeNs: ns(mtime),
    birthtimeNs: ns(mtime),
    ...dates,
  }
}
