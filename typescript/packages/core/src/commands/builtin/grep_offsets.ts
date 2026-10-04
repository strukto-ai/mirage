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
import { encodeText } from '../../shell/bytes.ts'
import { byteOffset } from '../../shell/helpers.ts'
import { matchStart, matchText } from './utils/pcre.ts'

/**
 * Byte offset of each line's own first byte within the whole input.
 *
 * A line iterator strips the terminator, so the accumulator advances by one
 * more than the line's own length. The extra byte past the last line is never
 * read, which is why a file with no final newline still reports a correct
 * offset for every line it does have. The lines must have come from
 * `decodeText`; a lossily decoded one cannot be counted back.
 */
export function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = []
  let position = 0
  for (const line of lines) {
    offsets.push(position)
    position += encodeText(line).length + 1
  }
  return offsets
}

/**
 * Where a match begins in bytes, given its character index.
 *
 * The pattern engine reports a code-unit index because both hosts hold a line
 * as text; GNU reports a byte count and reports the same number under C and
 * C.utf8, so the index is converted rather than printed.
 */
export function matchOffset(lineStart: number, line: string, index: number): number {
  return lineStart + byteOffset(line, index)
}

/**
 * Every match of a pattern in a line, found as ripgrep finds them.
 *
 * ripgrep iterates matches the way Rust's regex crate does: after an empty
 * match the search resumes one character on, and an empty match where the
 * previous match ended is skipped, so `b*` on `abc` is three matches. Returns
 * each match's code-unit index and text. Mirrors Python's rust_matches.
 */
export function rustMatches(pat: RegExp, line: string): [number, string][] {
  const re = compilePosixRegex(pat.source, `${pat.flags.replace(/[gy]/g, '')}g`)
  const matches: [number, string][] = []
  let pos = 0
  let lastEnd = -1
  while (pos <= line.length) {
    re.lastIndex = pos
    const m = re.exec(line)
    if (m === null) break
    const end = m.index + m[0].length
    if (m[0] === '') {
      // One character on, which a surrogate pair is too.
      pos = end + ((line.codePointAt(end) ?? 0) > 0xffff ? 2 : 1)
      if (end === lastEnd) continue
    } else {
      pos = end
    }
    lastEnd = end
    matches.push([matchStart(m), matchText(m)])
  }
  return matches
}

/**
 * What ripgrep's -o prints for one line, one piece per output line: each
 * match, empty ones included (`rustMatches`), or the whole line when nothing
 * in it matches, which is how ripgrep prints an inverted selection and a
 * context line under -o (14.1.1). Mirrors Python's rg_pieces.
 */
export function rgPieces(pat: RegExp, line: string): [number, string][] {
  const matches = rustMatches(pat, line)
  return matches.length > 0 ? matches : [[0, line]]
}

/** Incremental byte offsets for monotonically increasing match indices on one line. */
export class MatchOffsets {
  private index = 0

  constructor(
    private position: number,
    private readonly line: string,
  ) {}

  at(index: number): number {
    // A non-Unicode regex can stop between a surrogate pair. Keep that pair
    // for the next step, while matching the old prefix encoder's replacement.
    const before = this.line.charCodeAt(index - 1)
    const after = this.line.charCodeAt(index)
    const split = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    const end = split ? index - 1 : index
    this.position += byteOffset(this.line.slice(this.index, end), end - this.index)
    this.index = end
    return this.position + (split ? 3 : 0)
  }
}

/**
 * grep's line-number and byte-offset fields, in GNU's fixed order.
 *
 * GNU prints FILENAME, then LINE NUMBER, then BYTE OFFSET, whatever order the
 * flags were given in, and picks the separator once per line: a context line
 * renders every field with `-` where a selected line uses `:`.
 */
export function prefixOf(number: number | null, offset: number | null, selected = true): string {
  const separator = selected ? ':' : '-'
  let fields = ''
  if (number !== null) fields += String(number) + separator
  if (offset !== null) fields += String(offset) + separator
  return fields
}
