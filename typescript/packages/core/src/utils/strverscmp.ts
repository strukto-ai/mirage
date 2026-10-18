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

// The order glibc documents for strverscmp: text compares character by
// character, but when the first difference falls inside a run of digits the
// two whole runs compare as numbers, and a run that starts with "0" (longer
// than "0" itself) is a fraction that sorts before every whole number:
// 000 < 00 < 01 < 010 < 09 < 0 < 1 < 9 < 10. Measured against glibc 2.41
// on 637,100 random pairs: while the runs agree on zeros only, the one that
// stops sorts after the one that goes on ("00" > "001", "000" < "00").

function digit(char: string): boolean {
  return char.length === 1 && char >= '0' && char <= '9'
}

function digitsFrom(text: string, start: number): string {
  let end = start
  while (end < text.length && digit(text.charAt(end))) end += 1
  return text.slice(start, end)
}

function isFraction(run: string): boolean {
  return run.length > 1 && run.startsWith('0')
}

// The characters at `at` compared by code point, which is the order of their
// UTF-8 bytes; the end of a string sorts first.
function order(a: string, b: string, at: number): number {
  const x = a.codePointAt(at) ?? -1
  const y = b.codePointAt(at) ?? -1
  if (x === y) return 0
  return x < y ? -1 : 1
}

/**
 * Compare two strings in version order, as glibc's `strverscmp`: negative,
 * zero or positive as `a` sorts before, level with or after `b`.
 */
export function strverscmp(a: string, b: string): number {
  if (a === b) return 0
  let split = 0
  while (split < a.length && split < b.length && a[split] === b[split]) split += 1
  const left = a.charAt(split)
  const right = b.charAt(split)
  let head = split
  while (head > 0 && digit(a.charAt(head - 1))) head -= 1
  const runA = digitsFrom(a, head)
  const runB = digitsFrom(b, head)
  if (runA === '' || runB === '') return order(a, b, split)
  const fractionA = isFraction(runA)
  const fractionB = isFraction(runB)
  if (fractionA !== fractionB) return fractionA ? -1 : 1
  if (!fractionA && runA.length !== runB.length) return runA.length < runB.length ? -1 : 1
  if (fractionA && /^0*$/.test(a.slice(head, split)) && digit(left) !== digit(right)) {
    return digit(left) ? -1 : 1
  }
  return order(a, b, split)
}
