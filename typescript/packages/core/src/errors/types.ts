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

/**
 * A filesystem condition mirage can report, named once.
 *
 * Every boundary that has to say a condition in a number (POSIX for the
 * kernel adapters, preview1 for a WASI guest, CPython errnos for a
 * monty guest) keeps only a table from these names to its own numbers,
 * and nothing else. The POSIX table is the shared base and lives here;
 * each runtime dialect lives beside its boundary (`runtime/js/wasi.ts`,
 * `runtime/python/monty/errors.ts`). Every table stays total over this
 * union, and each table's own test fails a half-added member. The
 * spellings are the uppercase POSIX names because that is what `.code`
 * already carries throughout the TypeScript tree (python's enum uses
 * the same member names with lowercase values).
 *
 * Two members are mirage's own conditions rather than POSIX spellings:
 * `CROSS_MOUNT` is a rename whose ends live on different mounts (posix
 * says EXDEV, the WASI wire deliberately says ENOENT), and `NO_XATTR`
 * is "attribute not set", which POSIX names ENOATTR on macOS and
 * ENODATA on Linux.
 */
export type FsCondition =
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'ENOTEMPTY'
  | 'EXDEV'
  | 'CROSS_MOUNT'
  | 'ENOTSUP'
  | 'ELOOP'
  | 'EINVAL'
  | 'EIO'
  | 'EBUSY'
  | 'EROFS'
  | 'NO_XATTR'

export const FS_CONDITIONS: readonly FsCondition[] = [
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EACCES',
  'EPERM',
  'ENOTEMPTY',
  'EXDEV',
  'CROSS_MOUNT',
  'ENOTSUP',
  'ELOOP',
  'EINVAL',
  'EIO',
  'EBUSY',
  'EROFS',
  'NO_XATTR',
]

/** One condition's POSIX rendering: errno plus GNU strerror. */
export interface PosixErrno {
  errno: number
  phrase: string
}
