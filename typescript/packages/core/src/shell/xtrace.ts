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

import { encodeText } from './bytes.ts'

// Characters that force quoting.
const UNSAFE = /[^\w@%+=:,./-]/

function quoted(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

/**
 * One word as bash's trace writes it: bare when every character is safe,
 * else single-quoted with each `'` spelled `'\''`.
 */
function traceQuote(word: string): string {
  if (word === '') return "''"
  return UNSAFE.test(word) ? quoted(word) : word
}

/**
 * Render one `set -x` trace line for an expanded simple command.
 */
export function traceCommand(words: readonly string[]): Uint8Array {
  return encodeText('+ ' + words.map(traceQuote).join(' ') + '\n')
}

/** Render one `set -x` trace line for a scalar assignment. */
export function traceAssignment(key: string, val: string, append: boolean): Uint8Array {
  const op = append ? '+=' : '='
  const rendered = val === '' ? '' : traceQuote(val)
  return encodeText(`+ ${key}${op}${rendered}\n`)
}

/**
 * Render the trace line a declaration writes for an array operand: every
 * element single-quoted, a keyed one as `['k']='v'`.
 */
export function traceArray(key: string, items: readonly string[], append: boolean): Uint8Array {
  const shown = items.map((item) => {
    const eq = item.indexOf(']=')
    return item.startsWith('[') && eq > 0
      ? `[${quoted(item.slice(1, eq))}]=${quoted(item.slice(eq + 2))}`
      : quoted(item)
  })
  return encodeText(`+ ${key}${append ? '+=' : '='}(${shown.join(' ')})\n`)
}
