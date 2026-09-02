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
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========Copyright 2026 @ Strukto.AI All Rights Reserved. =========
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

import { constants as osConstants } from 'node:os'

import { classify } from '@struktoai/mirage-core/errors/index'
import type { FsCondition } from '@struktoai/mirage-core/errors/index'

// Positive POSIX errno values. FUSE callbacks want them negated; other
// kernel interfaces (FSKit) want them positive, so the classification is
// kept protocol-neutral here and adapters apply their own sign.
export const ENOENT = 2
export const EIO = 5
export const EACCES = 13
export const EEXIST = 17
export const EINVAL = 22
export const ENOTDIR = 20
export const EISDIR = 21
export const EROFS = 30
// macOS value; Linux is 39 — fuse-native normalizes.
export const ENOTEMPTY = 66
// A rename across mounts. The kernel reads this as "not one filesystem"
// and `mv` falls back to copy+unlink, so it must survive the trip out.
export const EXDEV = 18

// This kernel boundary's own numbering for the shared vocabulary: the
// naming lives in core's `classify`, and the numbers here are the
// host's (node:os supplies the platform-variant ones, mirroring how
// python's adapter reads its errno module).
const CONDITION_ERRNO: Record<FsCondition, number> = {
  ENOENT,
  ENOTDIR,
  EISDIR,
  EEXIST,
  EACCES,
  EPERM: osConstants.errno.EPERM,
  ENOTEMPTY,
  EXDEV,
  CROSS_MOUNT: EXDEV,
  ENOTSUP: osConstants.errno.ENOTSUP,
  ELOOP: osConstants.errno.ELOOP,
  EINVAL,
  EIO,
  EBUSY: osConstants.errno.EBUSY,
  EROFS,
  NO_XATTR: osConstants.errno.ENODATA,
}

const MESSAGE_ERRNO: [string[], number][] = [
  [['not empty', 'enotempty'], ENOTEMPTY],
  [['not a directory', 'enotdir'], ENOTDIR],
  [['is a directory', 'eisdir'], EISDIR],
  [['permission', 'eacces', 'read-only'], EACCES],
  [['file exists', 'eexist'], EEXIST],
  [['not found', 'no such', 'enoent', 'no mount'], ENOENT],
]

/**
 * Map a mirage-native error onto a positive POSIX errno.
 *
 * Mirrors Python's `mirage.mount.errors.classify_error` so both languages
 * report the same errno for the same backend failure. The naming lives in
 * core's `classify` (shared with the wasi shim and the monty encoders);
 * this adapter only renders the condition in host numbers. A stamped code
 * outside the vocabulary is passed through in the host's own numbering
 * (Python's raw OSError.errno passthrough), and the message needles are a
 * last resort for unstamped errors, not a classification channel.
 */
export function classifyErrno(err: unknown): number {
  const condition = classify(err)
  if (condition !== null) return CONDITION_ERRNO[condition]
  const code = (err as { code?: string }).code
  if (code !== undefined) {
    const errnos = osConstants.errno as Record<string, number>
    const passthrough = errnos[code]
    if (passthrough !== undefined) return passthrough
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  for (const [needles, errno] of MESSAGE_ERRNO) {
    if (needles.some((n) => msg.includes(n))) return errno
  }
  return EIO
}

/**
 * Build an error carrying a POSIX code, so the mount core can signal a
 * specific errno without importing any adapter's numbering.
 */
export function errnoError(code: FsCondition, message: string): Error {
  return Object.assign(new Error(message), { code })
}
