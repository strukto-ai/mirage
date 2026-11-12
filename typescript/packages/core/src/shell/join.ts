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

// A byte UTF-8 cannot read, carried as its surrogate escape (see
// `byteChar` in `shell/bytes.ts`): a lone low surrogate, not the second
// half of a pair.
const BYTE_SENTINEL = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g

function quoteToken(token: string): string {
  if (token === '') return "''"
  // Mirrors Python's shlex: a token is safe unquoted only if every
  // character is in the shlex safe set.
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(token)) return token
  const quoted = `'${token.split("'").join("'\\''")}'`
  return quoted.replace(
    BYTE_SENTINEL,
    (char) => `'$'\\x${(char.charCodeAt(0) - 0xdc00).toString(16).padStart(2, '0')}''`,
  )
}

/**
 * Join tokens into one shell line the parser reads back as exactly
 * those tokens (Python's `shlex.join`). Internal code that synthesizes
 * a line from tokens it already holds (xargs, timeout) must use this
 * instead of `join(' ')`: a plain join is re-parsed by the shell, so a
 * token with whitespace splits and `$(...)` in a token executes. A byte
 * UTF-8 cannot read goes in as `$'\xHH'`, since the parser reads UTF-8
 * only and the escape expands back to that byte.
 */
export function shellJoin(tokens: readonly string[]): string {
  return tokens.map(quoteToken).join(' ')
}
