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

import { admissionMatcher, fromUnits, units } from '../../rs/policy.ts'

/**
 * A command pattern's tokens. Whitespace-split; trailing wildcards are
 * dropped because a pattern is a prefix and already matches any
 * continuation (`git *` and `git` are the same rule; a bare `*` is every
 * command).
 */
export function splitPattern(pattern: string): string[] {
  const parts = admissionMatcher(null).ask('split_pattern', { pattern: units(pattern) })
  return (parts as number[][]).map(fromUnits)
}
/** Whether a pattern is a prefix of a line's tokens (command name first). */
export function patternMatches(pattern: string, tokens: readonly string[]): boolean {
  return (
    admissionMatcher(null).ask('pattern_matches', {
      pattern: units(pattern),
      tokens: tokens.map(units),
    }) === true
  )
}
/**
 * Whether a pattern can match some line running the node at a path.
 *
 * Neither side has to be the longer one, which is what separates this
 * from `patternMatches`: only the words the two share are read. A pattern
 * that runs past the path narrows what is reachable below it (`linear
 * issue list` reaches `linear issue`, because one line of that group is
 * allowed); a path that runs past the pattern is already covered (`linear
 * issue` reaches `linear issue list`).
 */
export function patternReaches(pattern: string, path: readonly string[]): boolean {
  return (
    admissionMatcher(null).ask('pattern_reaches', {
      pattern: units(pattern),
      tokens: path.map(units),
    }) === true
  )
}
