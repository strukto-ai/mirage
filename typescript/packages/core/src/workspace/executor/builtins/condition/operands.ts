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
import { FILE_PAIR_BINARY, FILE_UNARY } from './constants.ts'
import { flatLeaves, flatShape } from './shape.ts'

// The names test's words are read under: `test`, `[` (a command word, as in
// `command [ -e x ]`, or the shell's own `[ ]`) and the leaves of `[[ ]]`.
export const TEST_NAMES: ReadonlySet<string> = new Set(['test', '[', '[['])

/**
 * Which of a test's words name a file, as the kinds a classifier reads, by
 * test's own reading of them (`flatShape`): the operand of a file operator
 * (`-e x`) and both sides of `-nt`, `-ot` and `-ef` are paths, however they
 * are spelled, so a relative name a rule covers is judged as `stat` judges
 * it; every other word is left to the shape rules. `name` is `test`, `[` or
 * `[[`; `words` are the test's words after its name: `]` included for `[`,
 * one leaf's for `[[`. Mirrors Python's file_operands.
 */
export function fileOperands(name: string, words: readonly string[]): (ValueType | null)[] {
  const closed = name === '[' && words.length > 0 && words[words.length - 1] === ']'
  const kinds: (ValueType | null)[] = new Array<ValueType | null>(words.length).fill(null)
  for (const leaf of flatLeaves(flatShape(name, closed ? words.slice(0, -1) : words))) {
    if (leaf.kind === 'unary' && FILE_UNARY.has(leaf.op)) {
      kinds[leaf.at] = 'path'
    } else if (leaf.kind === 'binary' && FILE_PAIR_BINARY.has(leaf.op)) {
      kinds[leaf.left] = 'path'
      kinds[leaf.right] = 'path'
    }
  }
  return kinds
}
