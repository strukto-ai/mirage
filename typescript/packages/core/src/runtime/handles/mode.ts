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

const VALID = 'rwaxbt+'

/**
 * What an fopen-style mode string says about a handle.
 *
 * One vocabulary for every dialect that opens by mode: quickjs's
 * `std.open` passes these strings verbatim, and Python's preview1
 * oflags/rights/fdflags translate onto the same facts.
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

const BASES = ['r', 'w', 'a', 'x', 'wx']

/**
 * Read an fopen-style mode string into its facts, validating it.
 *
 * The rule is CPython's, the stricter of the two parsers this
 * replaced — one base, at most one each of `+`, `b`, `t`, and never
 * `b` together with `t` — widened by one C-dialect spelling: `wx`,
 * fopen's exclusive create, which CPython spells as a bare `x`. Both
 * dialects open by mode through this one parser, so it accepts the
 * union. A guest engine that tolerates looser spellings still (C
 * fopen reads `rr` as `r`) renders this refusal in its own dialect at
 * its own boundary.
 *
 * Args:
 *   mode: the mode as the caller spelled it (`r`, `w+b`, `a`, `wx`, ...).
 *
 * Throws:
 *   Error: the mode does not parse, in CPython's own wording.
 */
export function parseMode(mode: string): OpenMode {
  const count = (char: string): number => mode.split(char).length - 1
  let bases = ''
  for (const char of 'rwax') if (mode.includes(char)) bases += char
  let duplicated = false
  for (const char of VALID) if (count(char) > 1) duplicated = true
  if (
    mode.length === 0 ||
    /[^rwaxbt+]/.test(mode) ||
    duplicated ||
    (mode.includes('b') && mode.includes('t')) ||
    !BASES.includes(bases)
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
