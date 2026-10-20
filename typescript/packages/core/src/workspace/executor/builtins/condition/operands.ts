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

import type { ValueType } from '../../../../commands/spec/types.ts'
import { BINARY_OPS, FILE_PAIR_BINARY, FILE_UNARY } from './constants.ts'

// The names test's words are read under: `test`, `[` (a command word, as in
// `command [ -e x ]`, or the shell's own `[ ]`) and the leaves of `[[ ]]`.
export const TEST_NAMES: ReadonlySet<string> = new Set(['test', '[', '[['])
// The words that begin a test of their own inside a test's argv: test's
// connectives, and `[[`'s, which a line's reader keeps as words.
const OPENERS: ReadonlySet<string> = new Set(['!', '(', '-a', '-o', '&&', '||'])
// The words that end one.
const CLOSERS: ReadonlySet<string> = new Set([')', '-a', '-o', '&&', '||'])

/**
 * Which of a test's words name a file, as the kinds a classifier reads: the
 * operand of a file operator (`-e x`) and both sides of `-nt`, `-ot` and
 * `-ef` are paths, however they are spelled, so a relative name a rule covers
 * is judged as `stat` judges it; every other word is left to the shape rules.
 * A file operator that is the left operand of a binary one (`[ -e = x ]`)
 * compares as a string, as test reads it. `words` are the test's words after
 * its name, `]` included for `[`. Mirrors Python's file_operands.
 */
export function fileOperands(words: readonly string[]): (ValueType | null)[] {
  const kinds: (ValueType | null)[] = new Array<ValueType | null>(words.length).fill(null)
  words.forEach((word, i) => {
    if (FILE_PAIR_BINARY.has(word) && i > 0 && i < words.length - 1) {
      kinds[i - 1] = 'path'
      kinds[i + 1] = 'path'
    } else if (
      FILE_UNARY.has(word) &&
      i + 1 < words.length &&
      (i === 0 || OPENERS.has(words[i - 1] ?? '')) &&
      !leftOperand(words, i)
    ) {
      kinds[i + 1] = 'path'
    }
  })
  return kinds
}

/** Whether the word at `i` is the left operand of a binary test. */
function leftOperand(words: readonly string[], i: number): boolean {
  if (i + 2 >= words.length || !BINARY_OPS.has(words[i + 1] ?? '')) return false
  const after = words[i + 3]
  return after === undefined || CLOSERS.has(after) || after === ']'
}
