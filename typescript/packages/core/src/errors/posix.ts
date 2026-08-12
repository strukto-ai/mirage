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

import type { FsCondition, PosixSeat } from './types.ts'

// Linux-canonical numbers: core is runtime-agnostic and has no host
// errno module to ask (python's posix.py resolves per platform). A
// kernel adapter that must speak its host's dialect keeps its own
// condition -> number table (node/src/fuse/errors.ts pins macOS
// ENOTEMPTY, and fuse-native normalizes); what lives here once is the
// canonical numbering and the GNU strerror phrases every message
// renderer shares.
export const POSIX: Record<FsCondition, PosixSeat> = {
  ENOENT: { errno: 2, phrase: 'No such file or directory' },
  ENOTDIR: { errno: 20, phrase: 'Not a directory' },
  EISDIR: { errno: 21, phrase: 'Is a directory' },
  EEXIST: { errno: 17, phrase: 'File exists' },
  EACCES: { errno: 13, phrase: 'Permission denied' },
  EPERM: { errno: 1, phrase: 'Operation not permitted' },
  ENOTEMPTY: { errno: 39, phrase: 'Directory not empty' },
  EXDEV: { errno: 18, phrase: 'Invalid cross-device link' },
  // A cross-mount rename is EXDEV to every POSIX consumer: the kernel
  // reads it as "not one filesystem" and mv falls back to copy+unlink.
  CROSS_MOUNT: { errno: 18, phrase: 'Invalid cross-device link' },
  ENOTSUP: { errno: 95, phrase: 'Operation not supported' },
  ELOOP: { errno: 40, phrase: 'Too many levels of symbolic links' },
  EINVAL: { errno: 22, phrase: 'Invalid argument' },
  EIO: { errno: 5, phrase: 'Input/output error' },
  EBUSY: { errno: 16, phrase: 'Device or resource busy' },
  EROFS: { errno: 30, phrase: 'Read-only file system' },
  NO_XATTR: { errno: 61, phrase: 'No data available' },
}

/** The canonical POSIX errno for a condition. */
export function posixErrno(condition: FsCondition): number {
  return POSIX[condition].errno
}

/** The GNU strerror text for a condition. */
export function gnuPhrase(condition: FsCondition): string {
  return POSIX[condition].phrase
}
