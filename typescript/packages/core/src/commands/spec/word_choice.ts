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
 * The candidate words of an option that takes one of them, or an
 * unambiguous prefix of one. Each entry is one VALUE, spelled either as
 * the single word that names it or as an array of alias words that all
 * mean it. The grouping is not cosmetic: it is the whole of GNU's
 * ambiguity rule (two matching words inside one entry are one value and
 * match; two matching entries are two values and are ambiguous), and it
 * is what `validWordsBlock` renders one `  - ` line per, which is how
 * GNU answers `sort --check=x` with `  - 'quiet', 'silent'` on one line
 * and `  - 'diagnose-first'` on the next.
 *
 * `WordChoices` in word_choice.py is the twin.
 */
export type WordChoices = readonly (string | readonly string[])[]

/**
 * The two wordings a refused value picks between, spelled as the word the
 * message carries (`ls: invalid argument 'zzz' for '--time'`).
 */
export type WordRefusalKind = 'ambiguous' | 'invalid'

/**
 * What `matchWord` answers: the canonical word of the one value that
 * matched, or the wording GNU refuses the value with. Discriminated on
 * `matched` so a caller cannot read a refusal as a word, mirroring
 * Python's `WordMatch | WordRefusal`.
 */
export type WordChoiceResult =
  | { readonly matched: true; readonly word: string }
  | { readonly matched: false; readonly kind: WordRefusalKind }

/**
 * `choices` as one array of alias words per value.
 *
 * A flat candidate list is a set of one-word values, which is what lets a
 * spec's plain `choices` reach the matcher with no change to its
 * declaration.
 */
export function valueClasses(choices: WordChoices): readonly (readonly string[])[] {
  return choices
    .map((choice) => (typeof choice === 'string' ? [choice] : choice))
    .filter((group) => group.length > 0)
}

/**
 * One option value matched against its candidates, as GNU does.
 *
 * GNU's three answers, in one pass, measured against coreutils 9.4:
 *
 * 1. An EXACT word wins outright, even when it is a proper prefix of a
 *    longer candidate: `ls --quoting-style=shell` is `shell`, not an
 *    ambiguity with `shell-always`, and `ls --color=no` is `never`.
 * 2. Otherwise every word `value` is a prefix of matches. Plain byte
 *    prefix, case-sensitive (`ls --sort=NON` is invalid, neither
 *    ambiguous nor accepted), and a hyphen is an ordinary character
 *    (`--quoting-style=shell-a` resolves).
 * 3. Matching words are ACCEPTED when they all mean one value, and
 *    ambiguous only when they span two or more: `ls -l --time=a` hits
 *    `atime` and `access`, one value, exit 0, while `--time=c` hits
 *    `ctime` and `creation`, two values, exit 1.
 *
 * There is deliberately no empty-string branch, and adding one would be
 * a bug. `''` is a prefix of every candidate, so it falls through rule 2
 * into rule 3 and is ambiguous exactly when the candidates span two or
 * more values -- which is why `ls --sort=` and `wc --total=` answer
 * `ambiguous argument ''` while a one-value set accepts it.
 *
 * `match_word` in word_choice.py is the twin.
 */
export function matchWord(value: string, choices: WordChoices): WordChoiceResult {
  const classes = valueClasses(choices)
  for (const group of classes) {
    if (group.includes(value)) return { matched: true, word: group[0] ?? '' }
  }
  const matched = classes.filter((group) => group.some((word) => word.startsWith(value)))
  const first = matched[0]
  if (first === undefined) return { matched: false, kind: 'invalid' }
  if (new Set(matched.map((group) => group[0])).size > 1) {
    return { matched: false, kind: 'ambiguous' }
  }
  return { matched: true, word: first[0] ?? '' }
}
