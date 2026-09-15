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

import {
  CASE,
  COMMAND_PRECEDERS,
  COMMENT_PRECEDERS,
  ESAC,
  LINE_BLANKS,
  NESTED_QUOTES,
  QUOTE_OPENERS,
  SUBSTITUTION_OPENERS,
} from './constants.ts'

const NO_NESTED_QUOTES: ReadonlySet<string> = new Set()

/**
 * The character closing the construct that opens at `index`.
 *
 * `${` runs to its balancing brace, `$[` to its bracket, and `$(`,
 * `<(` and `>(` to their balancing paren. A lone `(` opens one only
 * inside another paren
 * construct, where it is a subshell or a parenthesized case pattern;
 * anywhere else it is ordinary text, as `cat <<EOF (` is. Returns null
 * when nothing opens here.
 */
export function constructCloser(text: string, index: number, bare: boolean): string | null {
  const char = text[index] ?? ''
  const following = text[index + 1]
  if (char === '$' && following === '{') return '}'
  if (char === '$' && following === '[') return ']'
  if (SUBSTITUTION_OPENERS.has(char) && following === '(') return ')'
  if (bare && char === '(') return ')'
  return null
}

/**
 * Whether `word` stands alone at `index` where a command starts.
 *
 * `case` and `esac` are reserved only there and only whole, so
 * `grep case f` names a file, `case=1` assigns a variable and `esacs`
 * is a word.
 */
export function reservedWord(text: string, index: number, word: string): boolean {
  if (text.slice(index, index + word.length) !== word) return false
  const after = text[index + word.length]
  if (after !== undefined && !COMMENT_PRECEDERS.has(after)) return false
  let position = index - 1
  while (position >= 0 && LINE_BLANKS.has(text[position] ?? '')) position -= 1
  return position >= 0 && COMMAND_PRECEDERS.has(text[position] ?? '')
}

/**
 * Offset just past the quote closing the one at `start`.
 *
 * A backslash escapes the next character inside double quotes, backticks
 * and `$'...'`, never inside a plain single-quoted string. Double quotes
 * and backticks also expand, so a substitution inside one runs to its
 * own close whatever it holds, and the quotes it holds are its own:
 * `"$( : "a<newline>b"; echo /out)"` closes at the quote after the
 * paren, not at the one before `a`. A backtick nests inside a double
 * quote and both quotes nest inside a backtick, while a `'` inside
 * double quotes is an ordinary character (`"it's"`). Returns null when
 * the quote never closes.
 */
export function quoteEnd(text: string, start: number): number | null {
  const quote = text[start] ?? ''
  const expands = quote !== "'"
  const escapes = expands || text[start - 1] === '$'
  const nested = NESTED_QUOTES.get(quote) ?? NO_NESTED_QUOTES
  let index = start + 1
  while (index < text.length) {
    const char = text[index] ?? ''
    const closer = expands && char === '$' ? constructCloser(text, index, false) : null
    if (char === '\\' && escapes) {
      index += 2
    } else if (char === quote) {
      return index + 1
    } else if (nested.has(char)) {
      const end = quoteEnd(text, index)
      if (end === null) return null
      index = end
    } else if (closer !== null) {
      const end = constructEnd(text, index, closer)
      if (end === null) return null
      index = end
    } else {
      index += 1
    }
  }
  return null
}

/**
 * Offset just past the character closing the construct at `start`.
 *
 * What the construct holds is read the way the operator line itself is:
 * a backslash escapes the next character, quotes hide their contents,
 * and a nested construct runs to its own close, all across newlines,
 * since no body is read until the word holding them is whole. Inside
 * `$( )` a `#` after a blank or a metacharacter opens a comment, because
 * a command may start there; inside `${ }` it is part of the word
 * (`${x:- #y}` expands to ` #y`). A `)` that ends a case pattern closes
 * no construct, so an open `case` is counted and the paren passed over
 * while one is: `$(case x in<newline>x)` runs to its `esac`, and a
 * parenthesized pattern balances itself. Brackets inside `$[...]` balance
 * too, including array subscripts. Returns null when the construct
 * never closes.
 */
export function constructEnd(text: string, start: number, closer: string): number | null {
  const paren = closer === ')'
  let index = start + (text[start] === '(' || text[start] === '[' ? 1 : 2)
  let cases = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    const nested = closer === ']' && char === '[' ? ']' : constructCloser(text, index, paren)
    if (char === '\\') {
      index += 2
    } else if (QUOTE_OPENERS.has(char)) {
      const end = quoteEnd(text, index)
      if (end === null) return null
      index = end
    } else if (nested !== null) {
      const end = constructEnd(text, index, nested)
      if (end === null) return null
      index = end
    } else if (char === closer && cases === 0) {
      return index + 1
    } else if (paren && reservedWord(text, index, CASE)) {
      cases += 1
      index += CASE.length
    } else if (cases > 0 && reservedWord(text, index, ESAC)) {
      cases -= 1
      index += ESAC.length
    } else if (paren && char === '#' && COMMENT_PRECEDERS.has(text[index - 1] ?? '')) {
      const newline = text.indexOf('\n', index)
      if (newline < 0) return null
      index = newline + 1
    } else {
      index += 1
    }
  }
  return null
}

/**
 * Offset of the newline ending the logical line the operator sits on.
 *
 * Read forward from the end of the delimiter word the way bash's reader
 * does: a backslash escapes the next character, so `\<newline>` continues
 * the line; quotes and backticks hide their contents; `$(`, `<(` and `>(`
 * run to their balancing paren and `${` to its balancing brace, both
 * across newlines, since no body is read until the word holding them is
 * whole; a `#` opening a word, which is one after a blank or a
 * metacharacter (`cat <<EOF;# don't`), starts a comment that ends at the
 * newline. A trailing `|` or `&&` does not extend the line: bash gathers
 * the body at the first newline and reads the rest of the pipeline after
 * the terminator. Returns null when the line never ends.
 */
export function operatorLineEnd(text: string, start: number): number | null {
  let index = start
  while (index < text.length) {
    const char = text[index] ?? ''
    const closer = constructCloser(text, index, false)
    if (char === '\\') {
      index += 2
    } else if (QUOTE_OPENERS.has(char)) {
      const end = quoteEnd(text, index)
      if (end === null) return null
      index = end
    } else if (closer !== null) {
      const end = constructEnd(text, index, closer)
      if (end === null) return null
      index = end
    } else if (char === '#' && index > 0 && COMMENT_PRECEDERS.has(text[index - 1] ?? '')) {
      const newline = text.indexOf('\n', index)
      return newline < 0 ? null : newline
    } else if (char === '\n') {
      return index
    } else {
      index += 1
    }
  }
  return null
}
