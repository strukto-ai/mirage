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

import { gnuPhrase } from './posix.ts'
import type { FsCondition } from './types.ts'

// Every code spelling the vocabulary names. Identity for the vocabulary's own
// names (which is what the utils/errors constructors, CycleError and
// CrossMountError stamp), plus the aliases other raisers use:
// EOPNOTSUPP is ENOTSUP's second POSIX spelling, and ENODATA/ENOATTR
// are the two platform names for one "attribute not set" condition.
export const CODE_ARMS: Record<string, FsCondition> = {
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
  ENODATA: 'NO_XATTR',
  ENOATTR: 'NO_XATTR',
}

export const ELOOP_STRERROR = 'Too many levels of symbolic links'

// The phrases live once, in the posix table. The DOMAIN here stays
// deliberately narrower than the vocabulary: these are the per-operand
// codes a read-family command skips-and-reports, and widening it (say
// to EIO) would widen isFsError's swallow set, which mirrors python's
// typed FS_ERRORS tuple, not the whole condition enum. ELOOP is in it
// because a link loop is a walk refusal met per operand (python's
// DotWalkLoop), widened in both languages together.
export const STRERROR: Record<string, string> = {
  // A read from a closed or write-only descriptor (`cat 0<&1`), raised
  // only by the shell's own unreadable stdin, not by any backend.
  EBADF: 'Bad file descriptor',
  ENOENT: gnuPhrase('ENOENT'),
  ENOTDIR: gnuPhrase('ENOTDIR'),
  EISDIR: gnuPhrase('EISDIR'),
  ELOOP: gnuPhrase('ELOOP'),
  EROFS: gnuPhrase('EROFS'),
  EACCES: gnuPhrase('EACCES'),
  EEXIST: gnuPhrase('EEXIST'),
  ENOTEMPTY: gnuPhrase('ENOTEMPTY'),
  ENOTSUP: gnuPhrase('ENOTSUP'),
  EXDEV: gnuPhrase('EXDEV'),
  // A read the backend refuses to render whole, raised by a mount's size
  // cap (not a POSIX condition mirage names, the way EBADF is not).
  EFBIG: 'File too large',
}

// The failures that happen after the open, which GNU words as the read
// step: a directory opens and then refuses the read, and the backend
// contract raises the other two for a read it will not serve. Mirrors
// Python's READ_FAILURES.
export const READ_FAILURES: ReadonlySet<string> = new Set(['EISDIR', 'EFBIG', 'EBADF'])
