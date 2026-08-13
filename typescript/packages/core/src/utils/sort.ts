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

/**
 * Order two strings by Unicode code point, the way Python's `sorted` does.
 *
 * JavaScript's default comparator compares UTF-16 code *units*. Astral
 * characters (U+10000 and up) are stored as a surrogate pair in
 * 0xD800-0xDFFF, so they sort before every BMP character from U+E000 up —
 * while Python puts them after. A directory holding `\u{1F600}.txt` and a
 * U+E000 name therefore lists in opposite orders across the two trees, and
 * any listing compared against a shared integ truth file diverges. See
 * issue #370.
 *
 * There is no Python counterpart because `sorted()` is already code-point
 * ordered; this is the module that makes TypeScript agree with it. Use it
 * for anything a user can see the order of. eslint bans the zero-argument
 * default comparator outright so it cannot creep back.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const aPoint = a.codePointAt(i) ?? 0
    const bPoint = b.codePointAt(j) ?? 0
    if (aPoint !== bPoint) return aPoint - bPoint
    i += aPoint > 0xffff ? 2 : 1
    j += bPoint > 0xffff ? 2 : 1
  }
  return a.length - i - (b.length - j)
}

/**
 * Sort a copy of `items` by code point.
 *
 * The copy is the point: sorting in place mutates, and most callers here
 * are handing back a list they do not own.
 */
export function sortedByCodePoints(items: Iterable<string>): string[] {
  return [...items].sort(compareCodePoints)
}
