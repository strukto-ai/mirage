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

import { classify, type FsCondition } from '../../../errors/index.ts'
import type { MontyDisplayableError } from './binding.ts'

/**
 * The error as guest CPython raises it for one condition: the builtin
 * exception a guest should be able to `except`, with CPython-on-Linux
 * numbering (a guest interpreter is platform-neutral, so the numbering
 * must not wobble with the host).
 */
export interface CPythonError {
  exception: string
  errno: number
  phrase: string
}

// The monty encoders' view, mirroring python's monty/errors.py. The
// table is total over the vocabulary; errors.test.ts fails a
// half-added member.
export const CPYTHON: Record<FsCondition, CPythonError> = {
  ENOENT: { exception: 'FileNotFoundError', errno: 2, phrase: 'No such file or directory' },
  ENOTDIR: { exception: 'NotADirectoryError', errno: 20, phrase: 'Not a directory' },
  EISDIR: { exception: 'IsADirectoryError', errno: 21, phrase: 'Is a directory' },
  EEXIST: { exception: 'FileExistsError', errno: 17, phrase: 'File exists' },
  EACCES: { exception: 'PermissionError', errno: 13, phrase: 'Permission denied' },
  EPERM: { exception: 'PermissionError', errno: 1, phrase: 'Operation not permitted' },
  ENOTEMPTY: { exception: 'OSError', errno: 39, phrase: 'Directory not empty' },
  EXDEV: { exception: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
  // pathlib's answer for a cross-mount rename: monty ships no shutil,
  // so guest code writes the copy-and-delete fallback by hand and the
  // errno is what tells it to.
  CROSS_MOUNT: { exception: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
  ENOTSUP: { exception: 'OSError', errno: 95, phrase: 'Operation not supported' },
  ELOOP: { exception: 'OSError', errno: 40, phrase: 'Too many levels of symbolic links' },
  EINVAL: { exception: 'OSError', errno: 22, phrase: 'Invalid argument' },
  EIO: { exception: 'OSError', errno: 5, phrase: 'Input/output error' },
  EBUSY: { exception: 'OSError', errno: 16, phrase: 'Device or resource busy' },
  EROFS: { exception: 'OSError', errno: 30, phrase: 'Read-only file system' },
  NO_XATTR: { exception: 'OSError', errno: 61, phrase: 'No data available' },
}

/** The guest-python rendering for a condition. */
export function cpythonError(condition: FsCondition): CPythonError {
  return CPYTHON[condition]
}

// The naming lives in the shared classifier; this module renders the
// condition in CPython's message shape. GuestCode survives as the name
// this encoder's callers know the vocabulary by.
export type GuestCode = FsCondition

/** The traceback monty renders for one of its own errors. */
export function displayError(err: unknown): string {
  const e = err as MontyDisplayableError
  if (typeof e.display === 'function') return e.display('traceback')
  return e instanceof Error ? e.message : String(err)
}

/**
 * Build the guest-side exception for one condition, in CPython's
 * message shape.
 *
 * Args:
 *   code: the condition, e.g. ENOENT.
 *   path: the path the operation names.
 *   target: rename's destination, when there is one.
 */
export function guestError(code: GuestCode, path: string, target?: string): Error {
  const row = cpythonError(code)
  const where = target === undefined ? `'${path}'` : `'${path}' -> '${target}'`
  const guest = new Error(`[Errno ${String(row.errno)}] ${row.phrase}: ${where}`)
  guest.name = row.exception
  return guest
}

/**
 * Re-throw a mount failure under its python exception name: the monty
 * binding raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host. Every named condition
 * converts (a non-empty rmdir is an OSError with errno 39, not a raw
 * JS error); a failure the vocabulary does not name passes through
 * untouched.
 *
 * Args:
 *   err: whatever the mount op rejected with.
 *   path: the path the operation names.
 */
export function asGuestError(err: unknown, path: string): unknown {
  const condition = classify(err)
  if (condition === null) return err
  return guestError(condition, path)
}
