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

const HEX_LETTERS = /^[a-f]+$/
// The letters a JSON escape ends with: `\b \f \n \r \t`, and the hex digit
// closing a `\u00XX` control character. Each can run into the word after it,
// so `\nice` holds "nice" where the message holds "ice".
const ESCAPE_LETTERS = new Set('abcdefnrt')

/**
 * The searches whose hits together hold every mounted record `text` may
 * match, or null when a provider's search cannot say.
 *
 * A mounted message is the provider's record as JSON, which holds more than
 * its search reads: key names, ids, counts, timestamps and flags, spelled
 * with JSON escapes. `text` is searched only when it is ASCII letters and
 * spaces, so no digit, quote or backslash can match outside the text the
 * search reads, and when none of its words is one of `keys` (the record's
 * key names and fixed values, lowercase) or a run of hex letters, which an
 * id can hold. Without whole-word matching a text inside a key is refused
 * too. A text starting with a letter an escape ends with may start inside
 * one, so the rest of it is searched as well (alone without whole-word
 * matching, where it is the wider search).
 */
export function recordQueries(
  text: string,
  keys: ReadonlySet<string>,
  wholeWord: boolean,
): string[] | null {
  if (text.trim() === '' || !/^[A-Za-z ]+$/.test(text)) return null
  const words = text
    .toLowerCase()
    .split(/ +/)
    .filter((word) => word !== '')
  if (words.some((word) => keys.has(word) || HEX_LETTERS.test(word))) return null
  const [only = ''] = words
  if (!wholeWord && words.length === 1 && [...keys].some((key) => key.includes(only))) {
    return null
  }
  const rest = text.slice(1).trim()
  if (!ESCAPE_LETTERS.has(text.charAt(0).toLowerCase()) || rest === '') return [text]
  return wholeWord ? [text, rest] : [rest]
}
