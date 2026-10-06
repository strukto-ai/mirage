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

import { compilePosixRegex } from '../../utils/posix.ts'
import { type IOResult } from '../../io/types.ts'
import { lineOffsets, MatchOffsets, prefixOf, rgPieces, rustMatches } from './grep_offsets.ts'
import { matchStart, matchText } from './utils/pcre.ts'

export interface GrepLinesOptions {
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  onlyMatching: boolean
  maxCount: number | null
  // -b: prefix each printed line with the byte offset of its own start, or of
  // the match itself under -o. Derived from the lines because this scan is
  // handed text rather than bytes, which is exact only for text that came
  // through `decodeText`.
  byteOffsets?: boolean
  // Given an IOResult, receives exit status 0 as soon as a line is selected.
  // Selection cannot be read off the returned list under -o, because GNU
  // prints nothing for a zero-width match and still counts the line, so a
  // caller deriving the status from an empty list reports 1 where GNU says 0.
  // Mirrors the `io` parameter of python's `grep_lines`.
  io?: IOResult
  // ripgrep's -o, which prints a line with no match whole (an inverted
  // selection), prints empty matches, and counts matches under -c; see
  // rgPieces.
  pieces?: boolean
}

export function grepLines(
  path: string,
  data: readonly string[],
  compiled: RegExp,
  opts: GrepLinesOptions,
): string[] {
  if (opts.maxCount === 0) {
    // GNU selects no line at all and the whole command goes quiet:
    // `grep -m0 -c a f` prints NOTHING, not `0`, and exits 1. An empty list
    // is what -c has to answer with, because a caller renders
    // `<file>:<count>` from whatever comes back and GNU prints no per-file
    // zeros under -m0 either. Read before the loop rather than after a line
    // is printed, because `count >= 0` is already true and the bottom check
    // would let the first selected line out first. `grepInput` takes the
    // same early return.
    return []
  }
  const results: string[] = []
  let count = 0
  const rgOnly = opts.onlyMatching && opts.pieces === true
  // ripgrep's -o -c counts matches, not the lines that hold them.
  let matches = 0
  const byteOffsets = opts.byteOffsets === true
  const offsets = byteOffsets ? lineOffsets(data) : []
  const reGlobal = opts.onlyMatching
    ? compilePosixRegex(
        compiled.source,
        compiled.flags.includes('g') ? compiled.flags : compiled.flags + 'g',
      )
    : null
  for (let i = 0; i < data.length; i++) {
    const line = data[i] ?? ''
    const start = byteOffsets ? (offsets[i] ?? 0) : 0
    const found = compiled.test(line)
    const matched = opts.invert ? !found : found
    if (!matched) continue
    count += 1
    if (opts.io !== undefined) opts.io.exitCode = 0
    if (opts.countOnly && rgOnly) matches += rustMatches(compiled, line).length
    if (!opts.countOnly && !opts.filesOnly) {
      if (rgOnly) {
        const pieceOffsets = byteOffsets ? new MatchOffsets(start, line) : null
        for (const [at, text] of rgPieces(compiled, line)) {
          const fields = prefixOf(opts.lineNumbers ? i + 1 : null, pieceOffsets?.at(at) ?? null)
          results.push(fields + text)
        }
      } else if (opts.onlyMatching) {
        // GNU -o prints every match on the line, one per line, and prints
        // nothing at all for an empty match nor for an inverted selection,
        // which has no match to print (`grep -ov abc` is zero bytes and exit
        // 0 where GNU's own -c still says 1). The line still counts as
        // selected, which is what -c, -l and the exit status read.
        if (!opts.invert && reGlobal !== null) {
          reGlobal.lastIndex = 0
          const matchOffsets = byteOffsets ? new MatchOffsets(start, line) : null
          for (;;) {
            const m = reGlobal.exec(line)
            if (m === null) break
            // A global regex that matched the empty string leaves lastIndex
            // where it was, so exec would keep returning it.
            if (m[0] === '') {
              reGlobal.lastIndex += 1
              continue
            }
            const text = matchText(m)
            if (text === '') continue
            const fields = prefixOf(
              opts.lineNumbers ? i + 1 : null,
              matchOffsets?.at(matchStart(m)) ?? null,
            )
            results.push(fields + text)
          }
        }
      } else {
        const fields = prefixOf(opts.lineNumbers ? i + 1 : null, byteOffsets ? start : null)
        results.push(fields + line)
      }
    }
    if (opts.maxCount !== null && count >= opts.maxCount) break
  }
  if (opts.countOnly) return [String(rgOnly ? matches : count)]
  if (opts.filesOnly) return count > 0 ? [path] : []
  return results
}

// The exit status grep and ripgrep share. An operand the search could not read
// is exit 2, and it outranks a match: both tools print the lines they did find
// and still exit 2. The one exception is grep's -q, documented as exiting zero
// when a match is found "even if an error was detected". Everything else is the
// familiar 0 for a match, 1 for none.
export function exitCodeFor(matched: boolean, failed: boolean, quiet: boolean): number {
  if (matched && quiet) return 0
  if (failed) return 2
  return matched ? 0 : 1
}
