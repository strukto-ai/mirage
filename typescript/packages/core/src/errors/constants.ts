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

import type { FsCondition } from './types.ts'

// Every code spelling the vocabulary names. Identity for the vocabulary's own
// names (which is what the errors/fs constructors, CycleError and
// CrossMountError stamp), plus the aliases other raisers use:
// EOPNOTSUPP is ENOTSUP's second POSIX spelling, and ENODATA/ENOATTR
// are the two platform names for one "attribute not set" condition.
export const CODE_ARMS: Record<string, FsCondition> = {
  EBADF: 'EBADF',
  ENOENT: 'ENOENT',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR',
  EEXIST: 'EEXIST',
  EACCES: 'EACCES',
  EPERM: 'EPERM',
  ENOTEMPTY: 'ENOTEMPTY',
  EXDEV: 'EXDEV',
  ENOTSUP: 'ENOTSUP',
  EOPNOTSUPP: 'ENOTSUP',
  ELOOP: 'ELOOP',
  EINVAL: 'EINVAL',
  EIO: 'EIO',
  EBUSY: 'EBUSY',
  EROFS: 'EROFS',
  EFBIG: 'EFBIG',
  ENODATA: 'NO_XATTR',
  ENOATTR: 'NO_XATTR',
}

// The conditions a command reports against one operand before it moves on
// to the next: the line ends in the condition's phrase, and isFsError
// swallows exactly these. A failure outside the set (EIO, a dropped
// connection) carries its own words and propagates. Mirrors python's
// OPERAND_CONDITIONS.
export const OPERAND_CONDITIONS: ReadonlySet<FsCondition> = new Set<FsCondition>([
  'EBADF',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'EEXIST',
  'EROFS',
  'EACCES',
  'ENOTEMPTY',
  'ENOTSUP',
  'EXDEV',
  'EFBIG',
])

// The failures that happen after the open, which a command words as the
// read step: a directory opens and then refuses the read, and the backend
// contract raises the other two for a read it will not serve. Mirrors
// Python's READ_FAILURES.
export const READ_FAILURES: ReadonlySet<string> = new Set(['EISDIR', 'EFBIG', 'EBADF'])
