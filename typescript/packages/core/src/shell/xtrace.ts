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

const META = /[ \t\n!"$&'()*;<>?[\\\]^`{|}]|^[#~]|[=:]~/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g
const CONTROL_ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '\x1b': '\\E',
}

function quoted(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

function controlEscape(char: string): string {
  return CONTROL_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`
}

/**
 * One word as bash's trace writes it (pinned on 5.2.37 in a UTF-8 locale):
 * single-quoted, each `'` spelled `'\''`, when it is empty, holds a blank or
 * a shell metacharacter, starts with `#` or `~`, or has a `~` after `=` or
 * `:`; else `$'...'` when it holds a control character; else bare, non-ASCII
 * letters included.
 */
function traceQuote(word: string): string {
  if (word === '' || META.test(word)) return quoted(word)
  const escaped = word.replace(CONTROL, controlEscape)
  return escaped === word ? word : `$'${escaped}'`
}

/**
 * Render one `set -x` trace line for an expanded simple command.
 */
export function traceCommand(words: readonly string[]): Uint8Array {
  return encodeText('+ ' + words.map(traceQuote).join(' ') + '\n')
}

/**
 * The `set -x` trace line for a scalar assignment, without its newline: an
 * assignment traces it into the shell's diagnostics, and `export` /
 * `readonly` among their own refusals.
 */
export function traceAssignment(key: string, val: string, append: boolean): string {
  const op = append ? '+=' : '='
  return `+ ${key}${op}${val === '' ? '' : traceQuote(val)}`
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
