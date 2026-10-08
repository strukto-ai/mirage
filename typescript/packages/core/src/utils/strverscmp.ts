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

// glibc strverscmp's automaton: a state per kind of run (none, integral,
// fractional, leading zeros), and what the first differing pair of characters
// decides in each, by the class of each (other, digit, zero).
const S_N = 0
const S_I = 3
const S_F = 6
const S_Z = 9
const CMP = 2
const LEN = 3
const NEXT_STATE = [S_N, S_I, S_Z, S_N, S_I, S_I, S_N, S_F, S_F, S_N, S_F, S_Z]
const RESULT_TYPE = [
  ...[CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP],
  ...[CMP, -1, -1, 1, LEN, LEN, 1, LEN, LEN],
  ...[CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP],
  ...[CMP, 1, 1, -1, CMP, CMP, -1, CMP, CMP],
]

/** A C string's character at `i`, NUL past its end. */
function charAt(text: string, i: number): string {
  return text[i] ?? '\0'
}

function digitClass(char: string): number {
  return (char === '0' ? 1 : 0) + (char >= '0' && char <= '9' ? 1 : 0)
}

/**
 * glibc's `strverscmp`: compare as versions, `v1.9` before `v1.10`.
 *
 * A digit run compares by its value, and one with a leading zero as a
 * fraction that sorts first: `000 < 00 < 01 < 010 < 09 < 0 < 1`. Only the sign
 * of the result means anything. Two characters that decide it compare by code
 * point, as in Python's twin.
 */
export function strverscmp(a: string, b: string): number {
  let i = 0
  let c1 = charAt(a, 0)
  let c2 = charAt(b, 0)
  let state = S_N + digitClass(c1)
  while (c1 === c2) {
    if (c1 === '\0') return 0
    state = NEXT_STATE[state] ?? S_N
    i += 1
    c1 = charAt(a, i)
    c2 = charAt(b, i)
    state += digitClass(c1)
  }
  const diff = (a.codePointAt(i) ?? 0) - (b.codePointAt(i) ?? 0)
  const result = RESULT_TYPE[state * 3 + digitClass(c2)] ?? CMP
  if (result === CMP) return diff
  if (result === LEN) {
    let k = i + 1
    while (digitClass(charAt(a, k)) > 0) {
      if (digitClass(charAt(b, k)) === 0) return 1
      k += 1
    }
    return digitClass(charAt(b, k)) > 0 ? -1 : diff
  }
  return result
}
