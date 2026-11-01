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

// The kernel reads host errno numbers. Only this boundary needs the
// platform-specific mapping; FUSE callbacks negate its positive result.
const CONDITION_ERRNO: Record<FsCondition, number> = {
  EBADF: osConstants.errno.EBADF,
  ENOENT: osConstants.errno.ENOENT,
  ENOTDIR: osConstants.errno.ENOTDIR,
  EISDIR: osConstants.errno.EISDIR,
  EEXIST: osConstants.errno.EEXIST,
  EACCES: osConstants.errno.EACCES,
  EPERM: osConstants.errno.EPERM,
  ENOTEMPTY: osConstants.errno.ENOTEMPTY,
  EXDEV: osConstants.errno.EXDEV,
  ENOTSUP: osConstants.errno.ENOTSUP,
  ELOOP: osConstants.errno.ELOOP,
  EINVAL: osConstants.errno.EINVAL,
  EIO: osConstants.errno.EIO,
  EBUSY: osConstants.errno.EBUSY,
  EROFS: osConstants.errno.EROFS,
  EFBIG: osConstants.errno.EFBIG,
  EDQUOT: osConstants.errno.EDQUOT,
  EPIPE: osConstants.errno.EPIPE,
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
  [['not empty', 'enotempty'], osConstants.errno.ENOTEMPTY],
  [['not a directory', 'enotdir'], osConstants.errno.ENOTDIR],
  [['is a directory', 'eisdir'], osConstants.errno.EISDIR],
  [['permission', 'eacces'], osConstants.errno.EACCES],
  [['file exists', 'eexist'], osConstants.errno.EEXIST],
  [['not found', 'no such', 'enoent'], osConstants.errno.ENOENT],
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
 * last resort for unstamped errors, not a classification channel. A kernel
 * mount and SFTP can hand back only the number, so a policy's reason for
 * a refusal goes to the operator log here, and so does an error nothing
 * names.
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
  // A bug in the core would otherwise read only as "I/O error".
  if (code === undefined) console.warn(`unclassified mount error: ${String(err)}`)
  return osConstants.errno.EIO
}

/** Same classification, negated for `@zkochan/fuse-native` callbacks. */
export function classifyError(err: unknown): number {
  return -classifyErrno(err)
}

/**
 * An SFTP request answered with a status the core cannot express as an
 * errno: an operation mirage does not offer, or a workspace that is not
 * there. asyncssh raises its own SFTPError classes for these on the
 * Python side.
 */
export class SFTPStatusError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SFTPStatusError'
    this.status = status
  }
}
