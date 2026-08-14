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

import type { FsCondition } from '../../errors/index.ts'

// WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
// numbering; the same table python's abi.py keeps). These are NOT
// POSIX values and must never be collapsed with them: ENOENT is 44 on
// the wire, and 18 here is EDOM where a POSIX host means EXDEV. The
// table is total over the vocabulary; wasi.test.ts fails a half-added
// member.
export const WASI: Record<FsCondition, number> = {
  ENOENT: 44,
  ENOTDIR: 54,
  EISDIR: 31,
  EEXIST: 20,
  EACCES: 2,
  EPERM: 63,
  ENOTEMPTY: 55,
  EXDEV: 75,
  // Each mount is its own preopen to a WASI guest, so a rename between
  // two of them reads as a destination that is not there. pathlib's
  // EXDEV is the monty dialect's answer, not this wire's; the row IS
  // that decision (finding 8).
  CROSS_MOUNT: 44,
  ENOTSUP: 58,
  ELOOP: 32,
  EINVAL: 28,
  EIO: 29,
  EBUSY: 10,
  EROFS: 69,
  // preview1 has no xattr syscalls, so this row is unreachable from a
  // guest; ENOTSUP is the honest answer if a future host ever asks.
  NO_XATTR: 58,
}

/** The preview1 wire number for a condition. */
export function wasiErrno(condition: FsCondition): number {
  return WASI[condition]
}
