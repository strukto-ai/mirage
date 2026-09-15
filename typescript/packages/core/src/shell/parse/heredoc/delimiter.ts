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

import { constructCloser, constructEnd, quoteEnd } from './line.ts'
import { decodeAnsiC } from '../../escapes.ts'
import { DQUOTE_ESCAPABLE } from './constants.ts'

/**
 * Index of the apostrophe closing a `$'` section.
 *
 * A backslash escapes the next character inside the section, the closing
 * quote included, so `$'\''` names one apostrophe. This is quoteEnd's
 * rule for the same section, read over a word's characters rather than
 * the source's bytes. Returns the word's length when the section never
 * closes.
 */
export function ansiCEnd(token: string, start: number): number {
  let index = start
  while (index < token.length) {
    if (token[index] === '\\' && index + 1 < token.length) {
      index += 2
      continue
    }
    if (token[index] === "'") return index
    index += 1
  }
  return token.length
}

/**
 * The delimiter word as bash reads it: quotes removed, escapes resolved.
 *
 * `'EOF'`, `"EOF"`, `EN'D'` and `\EOF` all end their body at a line
 * reading `END` or `EOF`; the quoting only decides whether the body
 * expands. Quote removal follows the shell's own rules: a backslash
 * escapes anything outside quotes, nothing inside single quotes, and
 * only `$`, `` ` ``, `"` and itself inside double quotes, so `"E\$F"`
 * names `E$F` while `"E\xF"` keeps its backslash. A `$` that is neither
 * quoted nor escaped opens a dollar-quoted section instead of naming
 * itself, wherever in the word it sits: `$'A\tB'` names the word its
 * ANSI-C escapes build, and `$"A"` names its double-quoted content,
 * which is what a locale carrying no translation for it gives back.
 * Every other `$` is literal, since a delimiter is never expanded. A
 * backslash before a newline is the reader's line continuation and takes
 * the newline with it, outside quotes and inside double quotes alike, so
 * `EO\<newline>F` names `EOF`; single quotes keep both characters,
 * leaving a newline in the delimiter that no single line can equal.
 */
export function literalConstructEnd(token: string, start: number): number | null {
  const closer = token[start] === '$' ? constructCloser(token, start, false) : null
  if (closer !== null) return constructEnd(token, start, closer)
  return token[start] === '`' ? quoteEnd(token, start) : null
}

export function cleanDelimiter(token: string): string {
  let out = ''
  let quote: string | null = null
  let index = 0
  while (index < token.length) {
    const char = token[index] ?? ''
    const end = quote === null ? literalConstructEnd(token, index) : null
    if (end !== null) {
      out += token.slice(index, end)
      index = end
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      else out += char
    } else if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && token[index + 1] === '\n') {
        index += 1
      } else if (
        char === '\\' &&
        index + 1 < token.length &&
        DQUOTE_ESCAPABLE.has(token[index + 1] ?? '')
      ) {
        index += 1
        out += token[index] ?? ''
      } else {
        out += char
      }
    } else if (char === '$' && token[index + 1] === "'") {
      const end = ansiCEnd(token, index + 2)
      out += decodeAnsiC(token.slice(index + 2, end))
      index = end
    } else if (char === '$' && token[index + 1] === '"') {
      quote = '"'
      index += 1
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '\\' && token[index + 1] === '\n') {
      index += 1
    } else if (char === '\\' && index + 1 < token.length) {
      index += 1
      out += token[index] ?? ''
    } else {
      out += char
    }
    index += 1
  }
  return out
}

/**
 * Whether the delimiter word is quoted, so its body reads literally.
 *
 * Quoting anywhere in the word, even partial (`EN'D'`, `\EOF`), turns
 * expansion off for the whole body. A backslash before a newline is not
 * quoting: it is the reader's line continuation, gone before the word is
 * read, so `EO\<newline>F` expands its body exactly as `EOF` does, while
 * `EO\<newline>F\G` does not, its second backslash quoting a character.
 */
export function delimiterQuoted(token: string): boolean {
  let index = 0
  while (index < token.length) {
    const char = token[index] ?? ''
    const end = literalConstructEnd(token, index)
    if (end !== null) {
      index = end
      continue
    }
    if (char === '\\' && token[index + 1] === '\n') index += 1
    else if (char === '\\' || char === "'" || char === '"') return true
    index += 1
  }
  return false
}
