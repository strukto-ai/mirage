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

// Characters that force quoting, mirroring Python's shlex.quote.
const UNSAFE = /[^\w@%+=:,./-]/

function traceQuote(word: string): string {
  if (word === '') return "''"
  if (!UNSAFE.test(word)) return word
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

/**
 * Render one `set -x` trace line for an expanded simple command.
 *
 * Words are shown post-expansion with bash's `+ ` prefix; words that
 * need it are single-quoted like bash's trace output.
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
