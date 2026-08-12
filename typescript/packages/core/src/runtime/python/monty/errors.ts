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

import { classify, type FsCondition, guestSeat } from '../../../errors/index.ts'
import type { MontyDisplayableError } from './binding.ts'

// The guest rendering (which python exception, which errno, which
// phrase) is the shared guest seat table's; this module only formats
// CPython's message shape around it. GuestCode survives as the name
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
  const seat = guestSeat(code)
  const where = target === undefined ? `'${path}'` : `'${path}' -> '${target}'`
  const guest = new Error(`[Errno ${String(seat.errno)}] ${seat.phrase}: ${where}`)
  guest.name = seat.name
  return guest
}

/**
 * Re-throw a mount failure under its python exception name: the monty
 * binding raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host. Every seated condition
 * converts (a non-empty rmdir is an OSError with errno 39, not a raw
 * JS error); an unseated failure passes through untouched.
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
