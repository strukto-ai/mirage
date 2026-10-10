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

import { classify } from './classify.ts'
import type { FsCondition } from './types.ts'

// WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
// numbering; the same table python's errors/wasi.py keeps). These are NOT
// POSIX values and must never be collapsed with them: ENOENT is 44 on
// the wire, and 18 here is EDOM where a POSIX host means EXDEV. The
// table is total over the vocabulary; errors.test.ts fails a half-added
// member.
export const WASI: Record<FsCondition, number> = {
  EBADF: 8,
  ENOENT: 44,
  ENOTDIR: 54,
  EISDIR: 31,
  EEXIST: 20,
  EACCES: 2,
  EPERM: 63,
  ENOTEMPTY: 55,
  EXDEV: 75,
  ENOTSUP: 58,
  ELOOP: 32,
  EINVAL: 28,
  EIO: 29,
  EBUSY: 10,
  EROFS: 69,
  EFBIG: 22,
  // preview1 has no xattr syscalls, so this row is unreachable from a
  // guest; ENOTSUP is the honest answer if a future host ever asks.
  NO_XATTR: 58,
  STALE_WRITE: 72,
}

/** The preview1 wire number for a condition. */
export function wasiErrno(condition: FsCondition): number {
  return WASI[condition]
}

/**
 * The preview1 wire number a thrown error renders as: the one rendering
 * every runtime that answers in preview1 numbers shares. Naming is the
 * shared classifier's. An error it does not name is EIO, which Python
 * keeps for an unnamed OSError; Python answers EINVAL for anything else,
 * a backend's bare ValueError, which has no class to tell apart here.
 * Mirrors Python's `errors/wasi.errno_for`.
 */
export function errnoFor(err: unknown): number {
  const condition = classify(err)
  return wasiErrno(condition ?? 'EIO')
}
