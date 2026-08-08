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

import type { ErrnoCodes, FSHost } from './types.ts'

/**
 * The conditions this filesystem can report, named rather than
 * numbered. Same split as `fuse/errors.ts`: the layer that decides a
 * call failed names the condition, and the adapter turns the name into
 * whatever number its kernel interface uses.
 */
export type FsErrorCode = 'ENOENT' | 'EPERM' | 'EINVAL' | 'EIO'

/**
 * Build an error naming a POSIX condition, for failures the host sees.
 *
 * Args:
 *   code: POSIX name of the condition.
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
 *
 * Args:
 *   host: the Emscripten FS namespace supplying `ErrnoError`.
 *   codes: that interpreter's errno table (`pyodide.ERRNO_CODES`).
 *   code: POSIX name of the condition to report.
 */
export function errnoError(host: FSHost, codes: ErrnoCodes, code: FsErrorCode): Error {
  return new host.ErrnoError(codes[code])
}
