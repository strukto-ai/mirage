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

import type { FsCondition } from '../../../errors/index.ts'
import type { ErrnoCodes, FSHost } from './types.ts'

/**
 * The conditions this filesystem can report, named rather than
 * numbered. Now the shared vocabulary (errors/types.ts) instead of a
 * private five-name union, so the layer that decides a call failed
 * names the same condition every other boundary does; the adapter
 * below still turns the name into whatever number the running
 * interpreter uses.
 */
export type FsErrorCode = FsCondition

// Condition -> the name the interpreter's own errno table knows it by.
// Identity except for mirage's two own conditions: the interpreter
// calls a cross-mount rename EXDEV, and "attribute not set" ENODATA.
const CONDITION_KEY: Record<FsCondition, keyof ErrnoCodes> = {
  ENOENT: 'ENOENT',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR',
  EEXIST: 'EEXIST',
  EACCES: 'EACCES',
  EPERM: 'EPERM',
  ENOTEMPTY: 'ENOTEMPTY',
  EXDEV: 'EXDEV',
  CROSS_MOUNT: 'EXDEV',
  ENOTSUP: 'ENOTSUP',
  ELOOP: 'ELOOP',
  EINVAL: 'EINVAL',
  EIO: 'EIO',
  EBUSY: 'EBUSY',
  EROFS: 'EROFS',
  NO_XATTR: 'ENODATA',
}

/**
 * Build an error naming a POSIX condition, for failures the host sees.
 *
 * Args:
 *   code: name of the condition.
 *   message: what failed, for a human reading the stack.
 */
export function fsError(code: FsErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Build the error a guest syscall should fail with.
 *
 * Both halves come from the running interpreter: the constructor so the
 * kernel recognizes it as an errno rather than a crash, and the number
 * so it is musl's and not a literal that happens to be right on Linux.
 * A name this build's table does not define answers EIO rather than
 * ErrnoError(undefined).
 *
 * Args:
 *   host: the Emscripten FS namespace supplying `ErrnoError`.
 *   codes: that interpreter's errno table (`pyodide.ERRNO_CODES`).
 *   code: name of the condition to report.
 */
export function errnoError(host: FSHost, codes: ErrnoCodes, code: FsErrorCode): Error {
  return new host.ErrnoError(codes[CONDITION_KEY[code]] ?? codes.EIO)
}
