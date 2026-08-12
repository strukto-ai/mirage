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
// names (which is what the utils/errors constructors, CycleError and
// CrossMountError stamp), plus the aliases other raisers use:
// EOPNOTSUPP is ENOTSUP's second POSIX spelling, and ENODATA/ENOATTR
// are the two platform names for one "attribute not set" condition.
const CODE_ARMS: Record<string, FsCondition> = {
  ENOENT: 'ENOENT',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR',
  EEXIST: 'EEXIST',
  EACCES: 'EACCES',
  EPERM: 'EPERM',
  ENOTEMPTY: 'ENOTEMPTY',
  EXDEV: 'EXDEV',
  CROSS_MOUNT: 'CROSS_MOUNT',
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

/**
 * Name the condition an error reports, if the vocabulary names one.
 *
 * The one classifier: every boundary (the fuse-native adapter, the
 * quickjs wasi shim, the monty encoders, pyodide's errno lookup) calls
 * this and then renders the condition through its own number table.
 * Keys on the stamped `code` (python's twin keys on exception class),
 * plus the registry's unstamped no-mount refusal, which is a miss.
 * Null means "no named condition" and the caller keeps its own
 * fallback, because a code outside the vocabulary is a passthrough,
 * not a translation.
 */
export function classify(err: unknown): FsCondition | null {
  if (err === null || typeof err !== 'object') return null
  if ((err as { noMount?: unknown }).noMount === true) return 'ENOENT'
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null
  return CODE_ARMS[code] ?? null
}
