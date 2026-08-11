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

import type { MontyDisplayableError } from './binding.ts'

// fs error codes -> the python exception the guest should catch, with
// CPython's errno message shape.
const CODE_TO_GUEST_EXC = {
  ENOENT: { name: 'FileNotFoundError', errno: 2, phrase: 'No such file or directory' },
  EISDIR: { name: 'IsADirectoryError', errno: 21, phrase: 'Is a directory' },
  ENOTDIR: { name: 'NotADirectoryError', errno: 20, phrase: 'Not a directory' },
  EACCES: { name: 'PermissionError', errno: 13, phrase: 'Permission denied' },
  EEXIST: { name: 'FileExistsError', errno: 17, phrase: 'File exists' },
  EXDEV: { name: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
} as const

export type GuestCode = keyof typeof CODE_TO_GUEST_EXC

function isGuestCode(code: string | undefined): code is GuestCode {
  return code !== undefined && code in CODE_TO_GUEST_EXC
}

/** The traceback monty renders for one of its own errors. */
export function displayError(err: unknown): string {
  const e = err as MontyDisplayableError
  if (typeof e.display === 'function') return e.display('traceback')
  return e instanceof Error ? e.message : String(err)
}

/**
 * Build the guest-side exception for one fs code, in CPython's message
 * shape.
 *
 * Args:
 *   code: the fs error code, e.g. ENOENT.
 *   path: the path the operation names.
 *   target: rename's destination, when there is one.
 */
export function guestError(code: GuestCode, path: string, target?: string): Error {
  const mapped = CODE_TO_GUEST_EXC[code]
  const where = target === undefined ? `'${path}'` : `'${path}' -> '${target}'`
  const guest = new Error(`[Errno ${String(mapped.errno)}] ${mapped.phrase}: ${where}`)
  guest.name = mapped.name
  return guest
}

/**
 * Re-throw a mount failure under its python exception name: the monty
 * binding raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host.
 *
 * Args:
 *   err: whatever the mount op rejected with.
 *   path: the path the operation names.
 */
export function asGuestError(err: unknown, path: string): unknown {
  const code = (err as { code?: string }).code
  if (!isGuestCode(code)) return err
  return guestError(code, path)
}
