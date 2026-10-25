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

import { concat } from '../../utils/bytes.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'
import type { TypeChange, TypeSelection } from './rg_filetypes.ts'
import { BOMS, bomOf, decoderFor } from '../../utils/encoding.ts'
const REPETITION = /\{[0-9]*(,[0-9]*)?\}/y
const ALNUM = /^[\p{L}\p{N}]$/u

/**
 * Normalized rg options, mirrored by Python's RgFlags.
 *
 * parseFlags resolves mutually overriding options in command-line order.
 * maxDepth counts children at depth 1. null terminates filenames;
 * nullData selects NUL-delimited records. typeChanges preserves add/clear
 * order; typeSelections pairs each type name with an exclusion bit.
 */
export interface RgFlags {
  ignoreCase: boolean
  smartCase: boolean
  invert: boolean
  wholeWord: boolean
  lineRegexp: boolean
  fixedString: boolean
  lineNumbers: boolean
  column: boolean
  vimgrep: boolean
  byteOffsets: boolean
  onlyMatching: boolean
  replace: string | null
  trim: boolean
  maxColumns: number | null
  maxColumnsPreview: boolean
  null: boolean
  nullData: boolean
  crlf?: boolean
  multiline?: boolean
  multilineDotall?: boolean
  stats?: boolean
  json?: boolean
  searchZip?: boolean
  pre?: string | null
  preGlobs?: readonly string[]
  pathSeparator: string | null
  quiet: boolean
  countOnly: boolean
  countMatches: boolean
  includeZero: boolean
  filesOnly: boolean
  filesWithoutMatch: boolean
  listFiles: boolean
  typeList: boolean
  withFilename: boolean
  noFilename: boolean
  heading: boolean
  passthru: boolean
  maxCount: number | null
  stopOnNonmatch: boolean
  contextAfter: number
  contextBefore: number
  contextSeparator: string | null
  fieldMatchSeparator: string
  fieldContextSeparator: string
  globs: readonly string[]
  iglobs: readonly string[]
  globCaseInsensitive: boolean
  typeChanges: readonly TypeChange[]
  typeSelections: readonly TypeSelection[]
  hidden: boolean
  maxDepth: number | null
  maxFilesize: number | null
  follow: boolean
  oneFileSystem: boolean
  binary: boolean
  sort: string | null
  sortReverse: boolean
  noMessages: boolean
  // The regex engine: `default` (ripgrep's own), `pcre2` or `auto`.
  engine: string
  // Unicode mode for either engine, on unless --no-unicode (or its alias
  // --no-pcre2-unicode) was given last.
  unicode: boolean
  // -j, null when the line left ripgrep to pick.
  threads: number | null
  // -a, which turns binary detection off; `binary` is -a, --binary or -uuu,
  // which also searches the files a walk would skip as binary.
  text: boolean
  // -E: auto (when unset), none, or the WHATWG name of the encoding a label
  // named.
  encoding?: string
}

/**
 * Whether the output shows -A/-B/-C context, which also puts the context
 * separator between one file's lines and the next file's. Only printed
 * lines carry it: -c, -l and --files-without-match answer per file. -o
 * keeps it, each line printed as its matches. --passthru prints every line
 * but never separates groups.
 */
export function printsContext(f: RgFlags): boolean {
  if (
    f.countOnly ||
    f.countMatches ||
    f.filesOnly ||
    f.filesWithoutMatch ||
    f.quiet ||
    f.passthru
  ) {
    return false
  }
  return f.contextBefore > 0 || f.contextAfter > 0
}

function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

// The literal a backslash escape at `i` stands for, if any, and where the
// pattern resumes.
function escapeLiteral(pattern: string, i: number): [string | null, number] {
  if (i + 1 >= pattern.length) return [null, pattern.length]
  const nxt = charAt(pattern, i + 1)
  if (nxt === 'p' || nxt === 'P') {
    if (pattern[i + 2] === '{') {
      const close = pattern.indexOf('}', i + 3)
      return [null, close === -1 ? pattern.length : close + 1]
    }
    return [null, i + 3]
  }
  if (nxt === 'x') {
    let digits: string
    let end: number
    if (pattern[i + 2] === '{') {
      const close = pattern.indexOf('}', i + 3)
      digits = close === -1 ? '' : pattern.slice(i + 3, close)
      end = close === -1 ? pattern.length : close + 1
    } else {
      digits = pattern.slice(i + 2, i + 4)
      end = i + 4
    }
    if (!/^[0-9A-Fa-f]+$/.test(digits)) return [null, end]
    const cp = Number.parseInt(digits, 16)
    return [cp <= 0x10ffff ? String.fromCodePoint(cp) : null, end]
  }
  if (ALNUM.test(nxt)) return [null, i + 1 + nxt.length]
  return [nxt, i + 1 + nxt.length]
}

/**
 * The literal characters of one ripgrep pattern, which is all smart case
 * looks at: class members and escaped punctuation count, while escapes like
 * `\w`, repetition counts, group syntax and POSIX class names do not.
 */
function* regexLiterals(pattern: string): Generator<string> {
  let i = 0
  let inClass = false
  while (i < pattern.length) {
    const ch = charAt(pattern, i)
    if (ch === '\\') {
      const [literal, next] = escapeLiteral(pattern, i)
      if (literal !== null) yield literal
      i = next
      continue
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false
        i += 1
      } else if (pattern.startsWith('[:', i)) {
        const close = pattern.indexOf(':]', i + 2)
        i = close === -1 ? i + 1 : close + 2
      } else {
        if (ch !== '-') yield ch
        i += ch.length
      }
      continue
    }
    if (ch === '[') {
      inClass = true
      i += 1
      if (pattern[i] === '^') i += 1
      if (pattern[i] === ']') {
        yield ']'
        i += 1
      }
      continue
    }
    if (pattern.startsWith('(?', i)) {
      let j = i + 2
      if (
        pattern.startsWith('P<', j) ||
        (pattern.startsWith('<', j) && !pattern.startsWith('<=', j) && !pattern.startsWith('<!', j))
      ) {
        const close = pattern.indexOf('>', j)
        i = close === -1 ? pattern.length : close + 1
        continue
      }
      while (j < pattern.length && pattern[j] !== ':' && pattern[j] !== ')') j += 1
      i = j < pattern.length && pattern[j] === ':' ? j + 1 : j
      continue
    }
    if (ch === '{') {
      REPETITION.lastIndex = i
      const rep = REPETITION.exec(pattern)
      if (rep !== null) {
        i += rep[0].length
        continue
      }
    }
    if (!'.^$*+?()|{'.includes(ch)) yield ch
    i += ch.length
  }
}

function isUpper(ch: string): boolean {
  return ch.toLowerCase() !== ch && ch.toUpperCase() === ch
}

/**
 * Whether -S searches `pattern` without regard to case: it has at least one
 * literal character and none of them is uppercase. `fixedString` is -F,
 * where every character is a literal.
 */
export function smartCaseFolds(pattern: string, fixedString: boolean): boolean {
  let found = false
  for (const part of pattern.split('\n')) {
    for (const ch of fixedString ? Array.from(part) : regexLiterals(part)) {
      found = true
      if (isUpper(ch)) return false
    }
  }
  return found
}

/**
 * What one haystack's search selected, beside what it printed: `binary` when
 * a binary-file notice stood in for the lines, `skipped` when a walked
 * binary file went unsearched, which no listing names but
 * --files-without-match's status counts.
 */
// What one haystack's search selected, beside what it printed. The counts
// are kept for --stats and --json: the matches in the selected lines, the
// selected lines, the bytes read before the search stopped, and a binary
// file's first NUL.
// Whether the search ignores case: -i, or -S over a pattern with no
// uppercase literal in it.
export function foldsCase(pattern: string, fixed: boolean, f: RgFlags): boolean {
  return f.ignoreCase || (f.smartCase && smartCaseFolds(pattern, fixed))
}

export interface Tally {
  selected: boolean
  binary?: boolean
  skipped?: boolean
  matches?: number
  matchedLines?: number
  searched?: number
  nul?: number | null
  // What ended the search early, in ripgrep's words: a -P search that gave up
  // at the backtracking limit.
  error?: string
}

/** What --stats and the --json summary add up over the haystacks. */
export class Totals {
  matches = 0
  matchedLines = 0
  withMatch = 0
  searched = 0
  printed = 0
  bytesSearched = 0
  elapsed = 0

  /** Add another run's totals: a line split over mounts prints one footer for all its runs. */
  merge(other: Totals): void {
    this.matches += other.matches
    this.matchedLines += other.matchedLines
    this.withMatch += other.withMatch
    this.searched += other.searched
    this.printed += other.printed
    this.bytesSearched += other.bytesSearched
    this.elapsed += other.elapsed
  }

  /** Count one haystack: its tally, the bytes printed for it, its seconds. */
  add(tally: Tally, printed: number, elapsed: number): void {
    this.matches += tally.matches ?? 0
    this.matchedLines += tally.matchedLines ?? 0
    this.withMatch += tally.selected ? 1 : 0
    this.searched += 1
    this.printed += printed
    this.bytesSearched += tally.searched ?? 0
    this.elapsed += elapsed
  }
}

const STATS_ROWS = [
  'matches',
  'matched lines',
  'files contained matches',
  'files searched',
  'bytes printed',
  'bytes searched',
  'seconds spent searching',
  'seconds',
]

/**
 * One run's output with the footer it ends with cut off, and the totals that
 * footer printed, read back the way the wc and du combiners read their total
 * rows; the output whole and null when it ends in none. `summary` reads
 * --json's summary record, not the --stats block. Mirrors Python's
 * `split_footer`.
 */
export function splitFooter(data: Uint8Array, summary: boolean): [Uint8Array, Totals | null] {
  if (data[data.length - 1] !== 10) return [data, null]
  // Back from the final newline to the one before the footer's first line.
  let at = data.length - 1
  for (let k = 0; k < (summary ? 1 : STATS_ROWS.length); k++) {
    at = at > 0 ? data.lastIndexOf(10, at - 1) : -1
    if (at < 0 && (!summary || k > 0)) return [data, null]
  }
  const rows = decodeText(data.subarray(at + 1, data.length - 1)).split('\n')
  const totals = new Totals()
  if (summary) {
    const last = rows[0] ?? ''
    if (!last.startsWith('{"data":') || !last.endsWith('"type":"summary"}')) return [data, null]
    const { stats } = (
      JSON.parse(last) as {
        data: {
          stats: {
            matches: number
            matched_lines: number
            searches_with_match: number
            searches: number
            bytes_printed: number
            bytes_searched: number
            elapsed: { secs: number; nanos: number }
          }
        }
      }
    ).data
    totals.matches = stats.matches
    totals.matchedLines = stats.matched_lines
    totals.withMatch = stats.searches_with_match
    totals.searched = stats.searches
    totals.printed = stats.bytes_printed
    totals.bytesSearched = stats.bytes_searched
    totals.elapsed = stats.elapsed.secs + stats.elapsed.nanos / 1e9
    return [data.subarray(0, at + 1), totals]
  }
  // The block opens with a blank line.
  if (at > 0 && data[at - 1] !== 10) return [data, null]
  const values: string[] = []
  for (const [k, label] of STATS_ROWS.entries()) {
    const row = rows[k] ?? ''
    const space = row.indexOf(' ')
    if (row.slice(space + 1) !== label || space < 0) return [data, null]
    values.push(row.slice(0, space))
  }
  totals.matches = Number(values[0])
  totals.matchedLines = Number(values[1])
  totals.withMatch = Number(values[2])
  totals.searched = Number(values[3])
  totals.printed = Number(values[4])
  totals.bytesSearched = Number(values[5])
  totals.elapsed = Number(values[6])
  return [data.subarray(0, at), totals]
}

const RG_BUFFER_BYTES = 64 * 1024

/**
 * ripgrep's binary detection over one haystack's bytes.
 *
 * grep-searcher looks for NUL in what it reads, ripgrep 14.1.1 in one of
 * three modes. `quit`, a walked file's: a NUL in the first 64 KiB leaves
 * the whole file unsearched, and one past it ends the search there.
 * `convert`, a file named on the line or any file under --binary: a NUL in
 * the first 64 KiB (all a memory map checks) makes the file binary, its
 * NULs read as line terminators, and a printed match gives way to one
 * notice naming the first NUL's offset. `text`, under -a or --null-data:
 * nothing is looked at. `note`, a named file under --json: the first NUL's
 * offset is kept for the end record, and the file is searched as it is.
 * Mirrors Python's RgBinary.
 */
export class RgBinary {
  offset: number | null = null

  constructor(readonly mode: 'quit' | 'convert' | 'note' | 'text') {}

  /**
   * Whether the file is binary and reads its NULs as terminators, a printed
   * match giving way to the notice.
   */
  get converted(): boolean {
    return this.mode === 'convert' && this.offset !== null
  }

  /**
   * The haystack's bytes, read the way the mode reads them. ripgrep checks
   * what one read returned, at most 64 KiB, before it searches a line of it.
   * `pipe` says the haystack is stdin, whose read returns what has arrived; a
   * file's read fills the buffer.
   */
  async *read(source: AsyncIterable<Uint8Array>, pipe = false): AsyncGenerator<Uint8Array> {
    if (this.mode === 'text') {
      yield* source
      return
    }
    let position = 0
    for await (const block of this.reads(source, pipe)) {
      const at = block.indexOf(0)
      if (at >= 0 && this.mode === 'quit') {
        if (position === 0) this.offset = at
        return
      }
      if (at >= 0 && position === 0) this.offset = at
      position += block.length
      yield this.convertBlock(block)
    }
  }

  /**
   * The reads ripgrep's buffer makes of the haystack. A pipe's read is
   * whatever had arrived, so each served chunk is one, never waited past, and
   * one longer than the buffer is cut into buffers. A file's first read fills
   * the buffer, since the binary decision rests on it, so the chunks a backend
   * serves (8 KiB from disk and S3) are held until it is whole and joined
   * once; later reads take what has arrived, so a search never waits past its
   * answer. A walked file's first buffer grows until it holds a whole line,
   * and a NUL in it ends the read the moment it arrives; a named file's first
   * buffer is all a memory map checks.
   */
  private async *reads(
    source: AsyncIterable<Uint8Array>,
    pipe: boolean,
  ): AsyncGenerator<Uint8Array> {
    let parts: Uint8Array[] = []
    let size = 0
    let newline: number | null = null
    let nul: number | null = null
    let filling = !pipe
    for await (const chunk of source) {
      if (!filling) {
        for (let start = 0; start < chunk.length; start += RG_BUFFER_BYTES) {
          yield chunk.subarray(start, start + RG_BUFFER_BYTES)
        }
        continue
      }
      if (newline === null) {
        const at = chunk.indexOf(0x0a)
        if (at >= 0) newline = size + at
      }
      if (nul === null) {
        const at = chunk.indexOf(0)
        if (at >= 0) nul = size + at
      }
      parts.push(chunk)
      size += chunk.length
      const end = this.firstEnd(newline)
      if (this.mode === 'quit' && nul !== null && (end === null || nul < end)) {
        yield concat(parts)
        return
      }
      if (end === null || size < end) continue
      const held = concat(parts)
      parts = []
      filling = false
      yield held.subarray(0, end)
      for (let start = end; start < held.length; start += RG_BUFFER_BYTES) {
        yield held.subarray(start, start + RG_BUFFER_BYTES)
      }
    }
    if (parts.length > 0) yield concat(parts)
  }

  /**
   * Where the first buffer ends: 64 KiB, or for a walked file the first 64 KiB
   * step past its first newline, null until one came.
   */
  private firstEnd(newline: number | null): number | null {
    if (this.mode !== 'quit') return RG_BUFFER_BYTES
    if (newline === null) return null
    return (Math.floor(newline / RG_BUFFER_BYTES) + 1) * RG_BUFFER_BYTES
  }

  /** Whether a walked file's first buffer held a NUL, so none of it was searched. */
  get skipped(): boolean {
    return this.mode === 'quit' && this.offset !== null
  }

  /** ripgrep's line for a binary file a printed match was found in. */
  notice(label: string | null): Uint8Array {
    const head = label === null ? '' : `${label}: `
    return encodeText(
      `${head}binary file matches (found "\\0" byte around offset ${String(this.offset)})\n`,
    )
  }

  private convertBlock(data: Uint8Array): Uint8Array {
    if (!this.converted) return data
    return data.map((byte) => (byte === 0 ? 0x0a : byte))
  }
}

/**
 * How one haystack's selected and context lines print (ripgrep's standard
 * printer): the fields, -o/--vimgrep/-r, --trim and -M. `label` is the path
 * every record leads with, null when the records carry none (a single
 * unlabelled input, or a --heading that already named the file).
 */
/**
 * What ends a line rg writes itself, as opposed to a line it read: NUL under
 * --null-data, CR LF under --crlf.
 */
export function recordEnd(f: RgFlags): string {
  return f.nullData ? '\0' : f.crlf === true ? '\r\n' : '\n'
}

async function* framed(
  head: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<readonly [Uint8Array, boolean]> {
  yield [head, false]
  for (let step = await rest.next(); step.done !== true; step = await rest.next()) {
    yield [step.value, false]
  }
  yield [new Uint8Array(0), true]
}

/**
 * A haystack's bytes as ripgrep searches them under -E auto or a named
 * encoding.
 *
 * A leading byte-order mark is dropped, and a UTF-16 one picks UTF-16
 * whatever -E said, where a UTF-8 one leaves the choice alone. Under auto
 * with no UTF-16 mark the rest passes as it is, invalid UTF-8 included.
 * Otherwise it is decoded to UTF-8, a sequence the encoding does not map
 * becoming U+FFFD, and a UTF encoding drops a second mark of its own too
 * (encoding_rs_io, ripgrep 14.1.1). Mirrors Python's `transcoded`.
 */
export async function* transcoded(
  source: AsyncIterable<Uint8Array>,
  encoding: string,
): AsyncGenerator<Uint8Array> {
  const rest = source[Symbol.asyncIterator]()
  try {
    let head: Uint8Array = new Uint8Array(0)
    while (head.length < 3) {
      const step = await rest.next()
      if (step.done === true) break
      head = concat([head, step.value])
    }
    let named = encoding === 'auto' ? null : encoding
    const bom = bomOf(head)
    if (bom !== null) {
      head = head.subarray(bom[0].length)
      if (bom[1] !== 'UTF-8') named = bom[1]
    }
    if (named === null) {
      if (head.length > 0) yield head
      for (let step = await rest.next(); step.done !== true; step = await rest.next()) {
        yield step.value
      }
      return
    }
    const decode = decoderFor(named)
    let marked = BOMS.some(([, name]) => name === named)
    for await (const [chunk, last] of framed(head, rest)) {
      let text = decode(chunk, last)
      if (marked && text !== '') {
        if (text.startsWith('\ufeff')) text = text.slice(1)
        marked = false
      }
      if (text !== '') yield encodeText(text)
    }
  } finally {
    // The iterator started here, which an iterable handing out a fresh one
    // does not close for it.
    await rest.return?.()
  }
}
