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

import { byteChar } from '../../../../shell/bytes.ts'
import { codePointText } from '../../../../shell/escapes.ts'
import { HEX, HEX_ESCAPE_DIGITS, OCT, SIMPLE_ESCAPES } from './constants.ts'

/**
 * Process C-style escape sequences for `echo -e`.
 *
 * Single-pass to handle `\\` correctly (`\\b` → a literal `\b`). Supports
 * `\\ \n \t \r \a \b \f \v`, `\e` and `\E` (ESC), `\xHH` (a byte),
 * `\uHHHH` and `\UHHHHHHHH` (a code point), `\0NNN` (octal) and `\c`
 * (stop output); an unknown escape like `\z` passes through as `\z`.
 * Returns the text and whether `\c` stopped the output, which also drops
 * echo's newline. `tr` has its own operand grammar in the Rust stream.
 * `\xHH` here names a byte, not a code point.
 */
export function interpretEscapes(text: string): [string, boolean] {
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
    const limit = HEX_ESCAPE_DIGITS[ch]
    if (simple !== undefined) {
      out.push(simple)
      i += 2
    } else if (ch === 'c') {
      return [out.join(''), true]
    } else if (limit !== undefined) {
      let digits = ''
      let j = i + 2
      while (j < n && digits.length < limit && HEX.has(text.charAt(j))) {
        digits += text.charAt(j)
        j += 1
      }
      if (digits !== '') {
        const value = parseInt(digits, 16)
        out.push(ch === 'x' ? byteChar(value) : codePointText(value))
        i = j
      } else {
        out.push('\\' + ch)
        i += 2
      }
    } else if (ch === '0') {
      let digits = ''
      let j = i + 2
      while (j < n && digits.length < 3 && OCT.has(text.charAt(j))) {
        digits += text.charAt(j)
        j += 1
      }
      out.push(digits !== '' ? byteChar(parseInt(digits, 8)) : '\0')
      i = j
    } else {
      out.push('\\')
      out.push(ch)
      i += 2
    }
  }
  return [out.join(''), false]
}
