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

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
})

const OCTAL_DIGITS = new Set('01234567')

const MAX_OCTAL = 0o400

/**
 * Read one of tr's SET operands, resolving backslash escapes.
 *
 * This is tr's grammar, which is narrower than the shell's in two ways and
 * wider in one. tr has no `\xHH` and no `\c`: both are ordinary unknown
 * escapes. An unknown escape *drops* the backslash and keeps the letter,
 * where `echo -e` passes `\z` through unchanged — so `tr '\x41' -` deletes
 * `x`, `4` and `1`, not `A`. Octal is written `\NNN` with no leading zero
 * required, greedy to three digits, so `\0141` is `\014` followed by a
 * literal `1`. A three-digit value above 255 is ambiguous; GNU backs off to
 * the first two digits and leaves the third as a literal.
 *
 * Not covered: GNU also writes a warning to stderr for that ambiguous case
 * (exit status is unaffected), which this pure reader has no channel for.
 * Values 128-255 name a byte in GNU and a code point here, which is the
 * same string-vs-bytes limit the rest of tr already carries.
 *
 * Mirrors Python's `interpret_escapes`.
 */
export function interpretEscapes(text: string): string {
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    if (text.charAt(i) !== '\\' || i + 1 >= n) {
      out.push(text.charAt(i))
      i += 1
      continue
    }
    const ch = text.charAt(i + 1)
    const simple = SIMPLE_ESCAPES[ch]
    if (simple !== undefined) {
      out.push(simple)
      i += 2
    } else if (OCTAL_DIGITS.has(ch)) {
      let digits = ''
      let j = i + 1
      while (j < n && digits.length < 3 && OCTAL_DIGITS.has(text.charAt(j))) {
        digits += text.charAt(j)
        j += 1
      }
      if (digits.length === 3 && Number.parseInt(digits, 8) >= MAX_OCTAL) {
        digits = digits.slice(0, 2)
        j -= 1
      }
      out.push(String.fromCharCode(Number.parseInt(digits, 8)))
      i = j
    } else {
      out.push(ch)
      i += 2
    }
  }
  return out.join('')
}
