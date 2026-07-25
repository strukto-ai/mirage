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

const MODE_CLASS_BITS: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 }
const MODE_PERM_BITS: Record<string, number> = { r: 0o444, w: 0o222, x: 0o111 }

export const DEFAULT_DIR_MODE = 0o755
export const DEFAULT_FILE_MODE = 0o644

// Parse a chmod MODE argument (octal or symbolic). Symbolic supports the
// common grammar: `[ugoa...][+-=][rwx...]` clauses joined by commas
// (`u+x`, `go-w`, `a=r`, `+x`). Special bits (s, t, X) are not supported.
// Returns the new mode, or null when the text does not parse.
export function parseMode(text: string, current: number): number | null {
  if (/^[0-7]+$/.test(text)) {
    const value = parseInt(text, 8)
    return value <= 0o7777 ? value : null
  }
  let mode = current
  for (const clause of text.split(',')) {
    let i = 0
    let classes = ''
    while (i < clause.length && 'ugoa'.includes(clause.charAt(i))) {
      classes += clause.charAt(i)
      i += 1
    }
    const action = clause[i]
    if (action === undefined || !'+-='.includes(action)) return null
    i += 1
    const perms = clause.slice(i)
    if (!/^[rwx]*$/.test(perms)) return null
    let classMask = 0
    for (const c of classes.length > 0 ? classes : 'a') {
      classMask |= MODE_CLASS_BITS[c] ?? 0
    }
    let permMask = 0
    for (const c of perms) permMask |= MODE_PERM_BITS[c] ?? 0
    const bits = classMask & permMask
    if (action === '+') mode |= bits
    else if (action === '-') mode &= ~bits
    else mode = (mode & ~classMask) | bits
  }
  return mode
}
