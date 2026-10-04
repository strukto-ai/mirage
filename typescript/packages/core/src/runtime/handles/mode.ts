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

import { MODE_BASES, MODE_CHARS } from './constants.ts'

// Inside a character class every mode letter (and +) is literal.
const INVALID_CHAR = new RegExp(`[^${MODE_CHARS}]`)

/**
 * What an fopen-style mode string says about a handle.
 *
 * One vocabulary for every dialect that opens by mode: monty's open
 * passes a CPython mode string, and quickjs's `std.open` and Python's
 * preview1 oflags/rights/fdflags translate onto the same facts.
 */
export interface OpenMode {
  /** The handle may read (r, +). */
  readable: boolean
  /** The handle may mutate its buffer (w, a, x, +). */
  writable: boolean
  /** Opening discards existing content (w). */
  truncate: boolean
  /** The position starts at the end (a). */
  append: boolean
  /** A missing file is created (w, a, x). */
  create: boolean
  /** An existing file refuses the open (x). */
  exclusive: boolean
  /** The handle carries bytes, not text (b). */
  binary: boolean
}

/**
 * Read an fopen-style mode string into its facts, validating it.
 *
 * The rule is CPython's: one base, at most one each of `+`, `b`, `t`,
 * and never `b` together with `t`. A guest that opens in C's dialect
 * (QuickJS's std.open: fopen reads `rr` as `r` and spells exclusive
 * creation `wx`) reads its own mode and builds these facts itself.
 *
 * Args:
 *   mode: the mode as the caller spelled it (`r`, `w+b`, `a`, `x`, ...).
 *
 * Throws:
 *   Error: the mode does not parse, in CPython's own wording.
 */
export function parseMode(mode: string): OpenMode {
  const count = (char: string): number => mode.split(char).length - 1
  let bases = ''
  for (const char of 'rwax') if (mode.includes(char)) bases += char
  let duplicated = false
  for (const char of MODE_CHARS) if (count(char) > 1) duplicated = true
  if (
    mode.length === 0 ||
    INVALID_CHAR.test(mode) ||
    duplicated ||
    (mode.includes('b') && mode.includes('t')) ||
    !MODE_BASES.includes(bases)
  ) {
    throw new Error(`invalid mode: '${mode}'`)
  }
  const plus = mode.includes('+')
  return {
    readable: mode.includes('r') || plus,
    writable: !mode.includes('r') || plus,
    truncate: mode.includes('w'),
    append: mode.includes('a'),
    create: /[wax]/.test(mode),
    exclusive: mode.includes('x'),
    binary: mode.includes('b'),
  }
}
