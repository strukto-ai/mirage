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

import { byteChar, encodeText } from '../../shell/bytes.ts'
import { byteOffset } from '../../shell/helpers.ts'

const DEC_REPLACE = new TextDecoder('utf-8', { ignoreBOM: true })

// Whether these bytes are valid UTF-8 on their own. `grep_binary.ts` exports
// its own `validUtf8`, which asks the same question of a rendered output chunk
// for the binary-file notice; this one is only the inner step of `decodeLine`,
// and keeping it here is what stops the conversion module importing back into
// the scanner that uses it.
function isUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return false
  }
}

/**
 * The input's bytes as text a byte offset can be counted back out of.
 *
 * The whole family holds a line as text, so every byte offset it prints is a
 * code-unit index converted back. That only answers GNU's number when the
 * conversion round-trips, which `TextDecoder`'s replacement does not: an
 * invalid byte becomes U+FFFD, three bytes wide, so a `-bo` match offset
 * inside such a line ran ahead of GNU's. A byte above ASCII is carried as its
 * surrogate escape instead, the convention `byteOffset` in `shell/helpers.ts`
 * already assumes through `encodeText`, and the twin of `decode_line` in
 * `grep_offsets.py`.
 */
export function decodeLine(raw: Uint8Array): string {
  if (isUtf8(raw)) return DEC_REPLACE.decode(raw)
  let text = ''
  for (let i = 0; i < raw.length; ) {
    const byte = raw[i]
    if (byte === undefined) break
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    const part = raw.subarray(i, i + width)
    if (part.length === width && isUtf8(part)) {
      text += DEC_REPLACE.decode(part)
      i += width
    } else {
      text += byteChar(byte)
      i += 1
    }
  }
  return text
}

/** Text back to the bytes `decodeLine` read it from. */
export function encodeLine(text: string): Uint8Array {
  return encodeText(text)
}

/**
 * Byte offset of each line's own first byte within the whole input.
 *
 * A line iterator strips the terminator, so the accumulator advances by one
 * more than the line's own length. The extra byte past the last line is never
 * read, which is why a file with no final newline still reports a correct
 * offset for every line it does have. The lines must have come from
 * `decodeLine`; a lossily decoded one cannot be counted back.
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
