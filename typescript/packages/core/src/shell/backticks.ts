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

import type { BacktickSegment } from './types.ts'

const ESCAPABLE: ReadonlySet<string> = new Set(['$', '`', '\\'])

/**
 * Split a backtick region into its commands and the text between them,
 * each with its span in the region.
 *
 * tree-sitter-bash lexes the gap between two backtick substitutions as
 * a single token when that gap is empty or whitespace-only, so
 * `` `a` `b` `` arrives as ONE command_substitution node holding both
 * commands and the literal text between them, and the node's subtree
 * merges the two commands into one that never runs. Re-lexing the
 * node's own text on unescaped backticks recovers the real segments; a
 * single pair simply yields one command segment. The evaluator runs
 * each command as a line of its own and the judging pass reads it the
 * same way, so this is the one lexer both share, and the spans are what
 * let each pair stand at its own place on the line.
 *
 * Inside a command, POSIX keeps the backslash literal except before
 * `$`, `` ` `` and `\\`, where it escapes. Consuming those pairs whole
 * is what makes the parity right: `\\\\` is one escaped backslash, so a
 * backtick straight after it still closes the region rather than
 * reading as an escaped backtick.
 */
export function splitBacktickRegion(raw: string): BacktickSegment[] {
  const segments: BacktickSegment[] = []
  let buf = ''
  let inCommand = false
  let start = 0
  let i = 0
  while (i < raw.length) {
    const next = raw[i + 1]
    if (raw[i] === '\\' && inCommand && next !== undefined && ESCAPABLE.has(next)) {
      buf += next
      i += 2
      continue
    }
    if (raw[i] === '`') {
      segments.push({ text: buf, command: inCommand, start, end: i })
      buf = ''
      inCommand = !inCommand
      i += 1
      start = i
      continue
    }
    buf += raw.charAt(i)
    i += 1
  }
  segments.push({ text: buf, command: inCommand, start, end: raw.length })
  return segments.filter((s) => s.text !== '' || s.command)
}
