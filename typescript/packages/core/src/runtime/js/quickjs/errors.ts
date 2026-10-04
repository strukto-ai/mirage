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

import { classify, type FsCondition } from '../../../errors/index.ts'

// WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
// numbering; the same table python's wasm/errors.py keeps). These are NOT
// POSIX values and must never be collapsed with them: ENOENT is 44 on
// the wire, and 18 here is EDOM where a POSIX host means EXDEV. The
// table is total over the vocabulary; errors.test.ts fails a half-added
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
  // A rename or link between two mounts is two file systems, as a
  // host answers across two preopens on different devices.
  CROSS_MOUNT: 75,
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

/** The preview1 wire number a thrown error renders as. */
export function errnoFor(err: unknown): number {
  // Naming is the shared classifier's; this boundary only renders the
  // condition in preview1 numbers. EIO is the same everything-else
  // fallback the python host keeps for an unnamed OSError.
  const condition = classify(err)
  return wasiErrno(condition ?? 'EIO')
}

export class QuickJsUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'QuickJsUnavailableError'
  }
}
