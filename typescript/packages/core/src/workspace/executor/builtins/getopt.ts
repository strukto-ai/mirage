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

/**
 * A bash builtin's option scan: letters as typed, then operands.
 *
 * `letters` keeps every option letter in the order it was typed, repeats
 * kept, so a builtin whose flags are mutually exclusive can apply bash's
 * last-one-wins rule. `bad` is the first invalid option, spelled the way
 * the refusal spells it, or null when every letter is known.
 */
export interface OptionScan {
  letters: readonly string[]
  operands: readonly string[]
  bad: string | null
}

/**
 * Scan a bash builtin's leading option letters.
 *
 * bash builtins take single letters only (`internal_getopt`), which is a
 * different grammar from the GNU tools `parseShellOptions` serves:
 * scanning is non-permuting and stops at `--` or the first non-option
 * word, a token carries options only when it starts with a dash and is
 * longer than one character, and every character after that dash is a
 * letter. A long spelling therefore fails on its second dash, which is
 * why bash refuses `type --foo` as `--` and not as `--foo` (pinned
 * against bash 5.2, debian:stable-slim).
 */
export function scanOptions(args: readonly string[], known: string): OptionScan {
  const letters: string[] = []
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (!(tok.startsWith('-') && tok.length > 1)) break
    for (const ch of tok.slice(1)) {
      if (!known.includes(ch)) return { letters: [], operands: [], bad: `-${ch}` }
      letters.push(ch)
    }
    i += 1
  }
  return { letters, operands: args.slice(i), bad: null }
}

/**
 * The last of a mutually exclusive letter group, as bash resolves it.
 *
 * bash holds such a group in one variable, so the last letter typed
 * wins: `type -tp` prints a path and `type -pt` a type word, and
 * `command -vV` is verbose where `command -Vv` is not.
 */
export function lastOf(letters: readonly string[], choices: string): string | null {
  for (let i = letters.length - 1; i >= 0; i -= 1) {
    const ch = letters[i] ?? ''
    if (choices.includes(ch)) return ch
  }
  return null
}
