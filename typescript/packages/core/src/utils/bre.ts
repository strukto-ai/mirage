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

// In a basic regular expression these are ordinary characters, and the
// backslashed spellings are the operators. That is the whole inversion:
// the RegExp engine reads them the other way round, so an untranslated BRE
// silently matches the wrong lines rather than failing.
const BRE_LITERALS = '+?|(){}'
const BACKREFERENCES = '123456789'
// A bracket expression takes its own rules: every character inside is
// ordinary, so the span is copied out untouched.
const CLASS_INTRODUCERS = ':.='

// Index just past a bracket expression opening at `start`. POSIX puts a literal
// `]` first, after an optional `^`, and `[:alpha:]`-style classes nest their own
// closing bracket, so neither ends the span.
function bracketEnd(pattern: string, start: number): number {
  let i = start + 1
  const n = pattern.length
  if (i < n && pattern.charAt(i) === '^') i += 1
  if (i < n && pattern.charAt(i) === ']') i += 1
  while (i < n && pattern.charAt(i) !== ']') {
    if (
      pattern.charAt(i) === '[' &&
      i + 1 < n &&
      CLASS_INTRODUCERS.includes(pattern.charAt(i + 1))
    ) {
      const closing = pattern.charAt(i + 1) + ']'
      const end = pattern.indexOf(closing, i + 2)
      i = end === -1 ? i + 2 : end + 2
    } else {
      i += 1
    }
  }
  return i < n ? i + 1 : n
}

// Whether a `$` at `index` is the end-of-line assertion: only at the very end of
// the pattern or immediately before `\)` or `\|`, and a literal dollar sign
// anywhere else. Pinned against GNU grep 3.x: `a$b` matches the three characters
// `a$b` while `\(a$\)` anchors.
function dollarAnchors(pattern: string, index: number): boolean {
  const rest = pattern.slice(index + 1)
  return rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')
}

/**
 * Translate a POSIX basic regular expression to the RegExp dialect.
 *
 * grep, sed and expr read basic expressions unless told otherwise, and RegExp
 * reads something close to an extended one, so handing a pattern straight over
 * inverts every operator in it. `a+b` looks for a literal plus to grep and for a
 * repeated `a` to RegExp, and both find something, which is why this went
 * unnoticed: the failure is a wrong answer, not an error.
 *
 * Every rule below is pinned against GNU grep 3.x rather than taken from a
 * specification, because the edge cases are where the two dialects differ most:
 *
 * - `+ ? | ( ) { }` are ordinary; `\+ \? \| \( \) \{ \}` are the operators (a
 *   GNU extension for the first three).
 * - `*` is ordinary where nothing precedes it to repeat: at the start of the
 *   pattern, and after `^`, `\(` or `\|`. `^*abc` matches a literal asterisk.
 * - `^` anchors only at those same starting positions, and `$` only at the end
 *   or before `\)` / `\|`. `a^b` and `a$b` are three literal characters each.
 * - A bracket expression is copied out whole: everything inside it is already
 *   ordinary in both dialects.
 *
 * @param pattern the expression as the user typed it
 */
export function breToRegExp(pattern: string): string {
  const out: string[] = []
  let index = 0
  const length = pattern.length
  // True where no expression precedes, so `*` cannot repeat anything and `^`
  // still anchors: the pattern start and just inside `\(`/`\|`.
  let fresh = true
  while (index < length) {
    const char = pattern.charAt(index)
    if (char === '[') {
      const end = bracketEnd(pattern, index)
      out.push(pattern.slice(index, end))
      index = end
      fresh = false
      continue
    }
    if (char === '\\' && index + 1 < length) {
      const following = pattern.charAt(index + 1)
      if (BRE_LITERALS.includes(following)) {
        out.push(following)
        fresh = following === '(' || following === '|'
      } else if (BACKREFERENCES.includes(following)) {
        out.push(`\\${following}`)
        fresh = false
      } else {
        out.push(`\\${following}`)
        fresh = false
      }
      index += 2
      continue
    }
    if (BRE_LITERALS.includes(char)) {
      out.push(`\\${char}`)
      fresh = false
    } else if (char === '^') {
      out.push(fresh ? '^' : '\\^')
    } else if (char === '$') {
      out.push(dollarAnchors(pattern, index) ? '$' : '\\$')
      fresh = false
    } else if (char === '*') {
      out.push(fresh ? '\\*' : '*')
      fresh = false
    } else {
      out.push(char)
      fresh = false
    }
    index += 1
  }
  return out.join('')
}
