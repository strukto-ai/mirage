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

import { decodeText } from '../../shell/bytes.ts'
import type { TypeChange, TypeSelection } from './rg_filetypes.ts'
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
  // ripgrep's compile limits in bytes, null (or unset) for its own.
  regexSizeLimit?: number | null
  dfaSizeLimit?: number | null
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

// Unicode's Uppercase property, which ripgrep's -S asks of a literal: a
// letter like `ℂ` has no lowercase and still counts.
function isUpper(ch: string): boolean {
  return /^\p{Uppercase}$/u.test(ch)
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

/** What ends a line rg writes itself: NUL under --null-data, CR LF under --crlf. */
export function recordEnd(f: RgFlags): string {
  return f.nullData ? '\0' : f.crlf === true ? '\r\n' : '\n'
}
