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

import { constants as osConstants } from 'node:os'

import { classify } from '@struktoai/mirage-core/errors/index'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import type { FsCondition } from '@struktoai/mirage-core/errors/index'

// Positive POSIX errno values in the host's numbering, which is what the
// kernel reads: fuse-native passes the number through, so a macOS value on
// Linux names a different error. FUSE callbacks want them negated; other
// kernel interfaces (FSKit) want them positive, so the classification is
// kept protocol-neutral here and adapters apply their own sign.
export const ENOENT = osConstants.errno.ENOENT
export const EIO = osConstants.errno.EIO
export const EACCES = osConstants.errno.EACCES
export const EEXIST = osConstants.errno.EEXIST
export const EINVAL = osConstants.errno.EINVAL
export const ENOTDIR = osConstants.errno.ENOTDIR
export const EISDIR = osConstants.errno.EISDIR
export const EROFS = osConstants.errno.EROFS
export const ENOTEMPTY = osConstants.errno.ENOTEMPTY
// A rename across mounts. The kernel reads this as "not one filesystem"
// and `mv` falls back to copy+unlink, so it must survive the trip out.
export const EXDEV = osConstants.errno.EXDEV

// This kernel boundary's own numbering for the shared vocabulary: the
// naming lives in core's `classify`, and the numbers here are the
// host's (node:os supplies the platform-variant ones, mirroring how
// python's adapter reads its errno module).
const CONDITION_ERRNO: Record<FsCondition, number> = {
  EBADF: osConstants.errno.EBADF,
  ENOENT,
  ENOTDIR,
  EISDIR,
  EEXIST,
  EACCES,
  EPERM: osConstants.errno.EPERM,
  ENOTEMPTY,
  EXDEV,
  ENOTSUP: osConstants.errno.ENOTSUP,
  ELOOP: osConstants.errno.ELOOP,
  EINVAL,
  EIO,
  EBUSY: osConstants.errno.EBUSY,
  EROFS,
  EFBIG: osConstants.errno.EFBIG,
  // "Attribute not set": ENOATTR on macOS, which node:os does not name,
  // and ENODATA on linux. Mirrors python's errors/posix.py.
  NO_XATTR: process.platform === 'darwin' ? 93 : osConstants.errno.ENODATA,
  STALE_WRITE: osConstants.errno.ESTALE,
}

// Genuine last resort, for an error whose only signal is its message (a
// third-party client's untyped failure). "read-only" and "no mount" are not
// here: those arrive typed and `classify` names them. Mirrors python's
// `_MESSAGE_CODES`.
const MESSAGE_ERRNO: [string[], number][] = [
  [['not empty', 'enotempty'], ENOTEMPTY],
  [['not a directory', 'enotdir'], ENOTDIR],
  [['is a directory', 'eisdir'], EISDIR],
  [['permission', 'eacces'], EACCES],
  [['file exists', 'eexist'], EEXIST],
  [['not found', 'no such', 'enoent'], ENOENT],
]

/**
 * Map a mirage-native error onto a positive POSIX errno.
 *
 * Mirrors Python's `mirage.fuse.errors.classify_error` so both languages
 * report the same errno for the same backend failure. The naming lives in
 * core's `classify` (shared with the wasi shim and the monty encoders);
 * this adapter only renders the condition in host numbers. A stamped code
 * outside the vocabulary is passed through in the host's own numbering
 * (Python's raw OSError.errno passthrough), and the message needles are a
 * last resort for unstamped errors, not a classification channel. A kernel
 * mount and SFTP can hand back only the number, so a policy's reason for
 * a refusal goes to the operator log here.
 */
export function classifyErrno(err: unknown): number {
  if (err instanceof PolicyDenied && err.refusal !== null) {
    console.info(`policy ${err.refusal.policy} refused ${err.virtualPath}: ${err.refusal.reason}`)
  }
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

/** Same classification, negated for `@zkochan/fuse-native` callbacks. */
export function classifyError(err: unknown): number {
  return -classifyErrno(err)
}

/**
 * Build an error carrying a POSIX code, so the mount core can signal a
 * specific errno without importing any adapter's numbering.
 */
export function errnoError(code: FsCondition, message: string): Error {
  return Object.assign(new Error(message), { code })
}
