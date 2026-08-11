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

import { SET_FLAG_TO_OPTION } from './types.ts'
import type { OptionWord } from './types.ts'

/**
 * Read one option word, or null when the word is an operand.
 *
 * This is bash's `set` grammar, which shell startup speaks too: a sign,
 * then either `o` naming an option in the next word or a cluster of
 * single-letter options, where `-` turns them on and `+` turns them off.
 * `bash -x file` and `set -x` therefore cannot disagree about what `-x`
 * means, and an option one of them learns the other gets.
 *
 * `-`, `--` and a `--long` word are not option words. The first two end
 * option parsing and the third belongs to whoever declares long options,
 * so both are the caller's to answer.
 */
export function parseOptionWord(word: string, next: string | null): OptionWord | null {
  const sign = word.charAt(0)
  if (word.length < 2 || (sign !== '-' && sign !== '+') || word.startsWith('--')) return null
  const enable = sign === '-'
  const settings: [string, boolean][] = []
  let other = ''
  let consumed = 1
  const chars = word.slice(1)
  for (let i = 0; i < chars.length; i++) {
    const char = chars.charAt(i)
    if (char === 'o') {
      if (next !== null) {
        settings.push([next, enable])
        consumed = 2
      }
      continue
    }
    const option = SET_FLAG_TO_OPTION[char]
    if (option === undefined) {
      other += char
      continue
    }
    settings.push([option, enable])
  }
  return { settings, other, consumed }
}
