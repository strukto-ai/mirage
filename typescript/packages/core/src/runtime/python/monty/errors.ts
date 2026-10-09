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
import { POSIX } from '../../../errors/posix.ts'

export class MontyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MontyUnavailableError'
  }
}

export interface MontyDisplayableError extends Error {
  display?: (format?: string) => string
}

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

// The builtin a guest `except`s for a condition, where CPython raises a
// subclass for its errno; every other condition is a plain OSError.
const EXCEPTIONS: Partial<Record<FsCondition, string>> = {
  ENOENT: 'FileNotFoundError',
  ENOTDIR: 'NotADirectoryError',
  EISDIR: 'IsADirectoryError',
  EEXIST: 'FileExistsError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
}

/**
 * The guest-python rendering for a condition: CPython on Linux, whose
 * number and phrase are the shared POSIX table's (that table is Linux's
 * numbering already).
 */
export function cpythonError(condition: FsCondition): CPythonError {
  return { exception: EXCEPTIONS[condition] ?? 'OSError', ...POSIX[condition] }
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
  const guest = Object.assign(new Error(`[Errno ${String(row.errno)}] ${row.phrase}: ${where}`), {
    guestCondition: code,
  })
  guest.name = row.exception
  return guest
}

/**
 * Re-throw a mount failure under its python exception name: the monty
 * engine raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host. Every named condition
 * converts (a non-empty rmdir is an OSError with errno 39, not a raw
 * JS error), and a failure the vocabulary does not name is EIO, as a
 * kernel reports a device that failed (the engine knows only builtin
 * types, so a backend's own error would reach the guest as
 * RuntimeError).
 *
 * Args:
 *   err: whatever the mount op rejected with.
 *   path: the path the operation names.
 *   target: a rename's destination, which CPython prints after the
 *     source.
 */
export function asGuestError(err: unknown, path: string, target?: string): unknown {
  // A guest exception this entry point already built (a refusal before any
  // mount op) is CPython's shape already, and keeps its own condition. A
  // backend error that merely shares a CPython name is classified like
  // any other.
  if ((err as { guestCondition?: unknown }).guestCondition !== undefined) return err
  return guestError(classify(err) ?? 'EIO', path, target)
}
