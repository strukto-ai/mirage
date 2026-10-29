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

import { WIDE, ZERO_WIDTH } from './generated/width_data.ts'

const CONTROL: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
]

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = ranges[mid]
    if (range === undefined) return false
    if (cp < range[0]) hi = mid - 1
    else if (cp > range[1]) lo = mid + 1
    else return true
  }
  return false
}

/**
 * How many terminal columns the character at `cp` occupies.
 *
 * Mirrors glibc's `wcwidth`: 2 for an East Asian wide or fullwidth
 * character, 0 for a combining mark, a Hangul jamo medial or final, or one of
 * the zero-width format characters, and 1 for everything else. A control
 * character measures 0 rather than `wcwidth`'s -1; callers handle tab,
 * newline, carriage return and form feed themselves, since those move the
 * cursor rather than occupy a column.
 *
 * Divergence: an unassigned code point measures 1 here and 0 in glibc, which
 * would need the assigned-character set on top of the width table.
 *
 * Mirrors Python's `char_width`.
 */
export function charWidth(cp: number): number {
  if (inRanges(cp, CONTROL)) return 0
  if (inRanges(cp, ZERO_WIDTH)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

/** How many terminal columns `text` occupies. Mirrors Python's `text_width`. */
export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}
