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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { discardStreams } from '../../io/stream.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { encodeText } from '../../shell/bytes.ts'
import { byteOffset } from '../../shell/helpers.ts'
import { decodeLine, encodeLine } from './grep_offsets.ts'
import type { TypeChange, TypeSelection } from './rg_filetypes.ts'

// ripgrep's words for a line -M will not print whole (ripgrep 14.1.1).
export const OMITTED_MATCHING = '[Omitted long matching line]'
export const OMITTED_CONTEXT = '[Omitted long context line]'
export const OMITTED_END = ' [... omitted end of long line]'
// What --trim strips: ASCII whitespace, as ripgrep's trim_ascii_prefix.
const ASCII_SPACE = ' \t\n\v\f\r'
const CAP_LETTER = /[0-9A-Za-z_]+/y
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
  oneFileSystem: boolean
  binary: boolean
  sort: string | null
  sortReverse: boolean
  noMessages: boolean
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

const GLOBAL = new WeakMap<RegExp, RegExp>()

function globalOf(pat: RegExp): RegExp {
  let found = GLOBAL.get(pat)
  if (found === undefined) {
    found = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
    GLOBAL.set(pat, found)
  }
  return found
}

/**
 * Every match on a line in the order Rust's regex iterates them. After an
 * empty match the search resumes one character on, and an empty match where
 * the previous match ended is skipped: `b*` over `abc` is empty, `b`, empty,
 * where a plain `exec` loop also yields the empty match right after `b`.
 */
export function* rustMatches(pat: RegExp, text: string): Generator<RegExpExecArray> {
  const re = globalOf(pat)
  let pos = 0
  let lastEnd = -1
  while (pos <= text.length) {
    re.lastIndex = pos
    const m = re.exec(text)
    if (m === null) return
    const end = m.index + m[0].length
    if (m[0].length === 0 && end === lastEnd) {
      pos = end + 1
      continue
    }
    yield m
    lastEnd = end
    pos = end > m.index ? end : end + 1
  }
}

// The group a `$` names at the start of `rest`, and its length.
function captureRef(rest: string): [string | null, number] {
  if (rest.length <= 1) return [null, 0]
  if (rest[1] === '{') {
    const close = rest.indexOf('}', 2)
    if (close === -1) return [null, 0]
    return [rest.slice(2, close), close + 1]
  }
  CAP_LETTER.lastIndex = 1
  const name = CAP_LETTER.exec(rest)
  if (name === null) return [null, 0]
  return [name[0], 1 + name[0].length]
}

// One group's text for a replacement, empty when there is none.
function capture(m: RegExpExecArray, ref: string): string {
  if (/^[0-9]+$/.test(ref)) return m[Number(ref)] ?? ''
  return m.groups?.[ref] ?? ''
}

/**
 * One match's -r replacement, expanded as Rust's `Captures::expand`: `$1`,
 * `${1}`, `$name` and `${name}` name a group, a name being the longest run
 * of `[0-9A-Za-z_]` (so `$1x` is the group `1x`), a group that did not take
 * part is empty, `$$` is `$`, and a `$` no name follows is itself.
 */
export function expand(template: string, m: RegExpExecArray): string {
  const out: string[] = []
  let i = 0
  for (;;) {
    const j = template.indexOf('$', i)
    if (j === -1) {
      out.push(template.slice(i))
      return out.join('')
    }
    out.push(template.slice(i, j))
    const rest = template.slice(j)
    if (rest.startsWith('$$')) {
      out.push('$')
      i = j + 2
      continue
    }
    const [ref, length] = captureRef(rest)
    if (ref === null) {
      out.push('$')
      i = j + 1
      continue
    }
    out.push(capture(m, ref))
    i = j + length
  }
}

/**
 * The line with every match replaced, and where each replacement landed in
 * it, which --vimgrep's columns and -M's preview count read.
 */
export function replaceAll(
  pat: RegExp,
  text: string,
  template: string,
): [string, [number, number][]] {
  const pieces: string[] = []
  const spans: [number, number][] = []
  let last = 0
  let length = 0
  for (const m of rustMatches(pat, text)) {
    const before = text.slice(last, m.index)
    pieces.push(before)
    length += before.length
    const replaced = expand(template, m)
    spans.push([length, length + replaced.length])
    pieces.push(replaced)
    length += replaced.length
    last = m.index + m[0].length
  }
  pieces.push(text.slice(last))
  return [pieces.join(''), spans]
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

/**
 * ripgrep's two spellings of a named group, `(?P<name>` and `(?<name>`, in
 * the one JavaScript's engine reads, `(?<name>`. A lookbehind, an escaped
 * paren and a bracket class are left alone.
 */
export function hostNamedGroups(pattern: string): string {
  const out: string[] = []
  let i = 0
  let inClass = false
  while (i < pattern.length) {
    const ch = pattern[i] ?? ''
    if (ch === '\\') {
      out.push(pattern.slice(i, i + 2))
      i += 2
      continue
    }
    if (inClass) {
      inClass = ch !== ']'
      out.push(ch)
      i += 1
      continue
    }
    if (ch === '[') {
      inClass = true
      let j = i + 1
      if (pattern[j] === '^') j += 1
      if (pattern[j] === ']') j += 1
      out.push(pattern.slice(i, j))
      i = j
      continue
    }
    if (pattern.startsWith('(?P<', i)) {
      out.push('(?<')
      i += 4
      continue
    }
    out.push(ch)
    i += 1
  }
  return out.join('')
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

function byteLen(text: string): number {
  return encodeText(text).length
}

/**
 * Byte offsets of ever later positions in one line, each counted on from
 * the one before, so a line's matches cost one pass over it rather than one
 * per match.
 */
export class ByteCursor {
  private index = 0
  private offset = 0

  constructor(private readonly text: string) {}

  // The byte offset of an index into the line, no earlier than the last
  // one asked for.
  at(index: number): number {
    this.offset += byteLen(this.text.slice(this.index, index))
    this.index = index
    return this.offset
  }
}

/** What one haystack's search selected, beside what it printed. */
export interface Tally {
  selected: boolean
}

function lstripAscii(text: string): string {
  let i = 0
  while (i < text.length && ASCII_SPACE.includes(text[i] ?? '')) i += 1
  return text.slice(i)
}

/**
 * How one haystack's selected and context lines print (ripgrep's standard
 * printer): the fields, -o/--vimgrep/-r, --trim and -M. `label` is the path
 * every record leads with, null when the records carry none (a single
 * unlabelled input, or a --heading that already named the file).
 */
export class RgPrinter {
  // ripgrep tracks each match of a line only when something needs it, and
  // -M words its refusal from whether it did.
  private readonly granular: boolean

  constructor(
    private readonly f: RgFlags,
    private readonly pat: RegExp,
    private readonly label: string | null,
  ) {
    this.granular = f.column || f.vimgrep || f.replace !== null || f.onlyMatching
  }

  // The records one context line prints: the line, or under -o each of its
  // matches (the whole line when it has none).
  context(index: number, start: number, text: string): Uint8Array[] {
    if (this.f.onlyMatching) {
      return [...this.pieces(index, start, text, [...rustMatches(this.pat, text)], false)]
    }
    return [this.record(index, null, start, text, [], false, true, 0)]
  }

  // The records one selected line prints, one per match under -o and
  // --vimgrep, produced as they are asked for.
  *selected(index: number, start: number, text: string): Generator<Uint8Array> {
    const f = this.f
    const matches = f.invert || !this.granular ? [] : [...rustMatches(this.pat, text)]
    if (f.onlyMatching) {
      yield* this.pieces(index, start, text, matches, true)
      return
    }
    let shown: string
    let spans: [number, number][]
    let terminated: boolean
    if (f.replace !== null && matches.length > 0) {
      ;[shown, spans] = replaceAll(this.pat, text, f.replace)
      terminated = false
    } else {
      shown = text
      spans = matches.map((m): [number, number] => [m.index, m.index + m[0].length])
      terminated = true
    }
    if (f.vimgrep && matches.length > 0) {
      // One record per match, each at its own column unless --no-column
      // took the columns away.
      const cursor = new ByteCursor(shown)
      for (const [s] of spans) {
        const column = f.column ? 1 + cursor.at(s) : null
        yield this.record(index, column, start, shown, spans, true, terminated, matches.length)
      }
      return
    }
    const first = spans[0]
    const column = f.column && first !== undefined ? 1 + byteOffset(shown, first[0]) : null
    yield this.record(index, column, start, shown, spans, true, terminated, matches.length)
  }

  // -o's records for one line: every match, an empty one included, each at
  // its own offset, or the whole line when nothing in it matches, which is how
  // ripgrep 14.1.1 prints an inverted selection and a context line under -o.
  private *pieces(
    index: number,
    start: number,
    text: string,
    matches: readonly RegExpExecArray[],
    isMatch: boolean,
  ): Generator<Uint8Array> {
    const f = this.f
    if (matches.length === 0) {
      yield this.record(index, null, start, text, [], isMatch, true, 0)
      return
    }
    const cursor = new ByteCursor(text)
    for (const m of matches) {
      let piece = m[0]
      if (f.replace !== null && isMatch) piece = expand(f.replace, m)
      const offset = cursor.at(m.index)
      const column = f.column && isMatch ? 1 + offset : null
      yield this.record(
        index,
        column,
        start + offset,
        piece,
        [[0, piece.length]],
        isMatch,
        false,
        1,
      )
    }
  }

  // One printed record. `terminated` says whether ripgrep's -M counts the
  // line's terminator in its length (a plain line does, a replaced line and
  // a -o match do not); `count` is the line's match count -M reports.
  private record(
    index: number,
    column: number | null,
    offset: number,
    text: string,
    spans: readonly (readonly [number, number])[],
    isMatch: boolean,
    terminated: boolean,
    count: number,
  ): Uint8Array {
    const f = this.f
    const sep = isMatch ? f.fieldMatchSeparator : f.fieldContextSeparator
    let head = ''
    if (this.label !== null) head = this.label + (f.null ? '\0' : sep)
    if (f.lineNumbers) head += `${String(index + 1)}${sep}`
    if (column !== null) head += `${String(column)}${sep}`
    if (f.byteOffsets) head += `${String(offset)}${sep}`
    let body = text
    let kept = spans
    if (f.trim) {
      body = lstripAscii(text)
      const cut = text.length - body.length
      kept = spans.filter(([s]) => s >= cut).map(([s, e]): [number, number] => [s - cut, e - cut])
    }
    if (f.maxColumns !== null && f.maxColumns > 0) {
      if (byteLen(body) + (terminated ? 1 : 0) > f.maxColumns) {
        body = this.exceeded(body, kept, isMatch, count)
      }
    }
    return encodeLine(`${head}${body}${f.nullData ? '\0' : '\n'}`)
  }

  // What -M prints for a line longer than its limit.
  private exceeded(
    body: string,
    spans: readonly (readonly [number, number])[],
    isMatch: boolean,
    count: number,
  ): string {
    const f = this.f
    const limit = f.maxColumns ?? 0
    const granular = this.granular && isMatch && spans.length > 0
    if (f.maxColumnsPreview) {
      // Code points, like Python's slice.
      const shown = Array.from(body).slice(0, limit).join('')
      if (!granular) return shown + OMITTED_END
      const remaining = spans.filter(([s]) => shown.length <= s && s < body.length).length
      const noun = remaining === 1 ? 'match' : 'matches'
      return `${shown} [... ${String(remaining)} more ${noun}]`
    }
    if (!granular || f.onlyMatching) return isMatch ? OMITTED_MATCHING : OMITTED_CONTEXT
    return `[Omitted long line with ${String(count)} matches]`
  }
}

function selects(pat: RegExp, text: string, invert: boolean): boolean {
  return pat.test(text) !== invert
}

/**
 * Where --stop-on-nonmatch ends a file: at the first unselected line after
 * a selected one. ripgrep's fast inverted search is one line late: the
 * pattern line that ends the first run of selected lines is passed over,
 * unprinted, and the stop comes at the next unselected line. That is how it
 * reads a file it names (through a memory map); a buffered read of stdin
 * stops at that first pattern line instead, which is not reproduced.
 * --passthru reads line by line and is never late.
 */
export class NonmatchStop {
  armed = false
  private seen = false

  constructor(
    private readonly enabled: boolean,
    private readonly late: boolean,
  ) {}

  // Record a selected line.
  select(): void {
    this.seen = true
    if (this.enabled && !this.late) this.armed = true
  }

  // Whether this unselected line is the one a late stop passes over, which
  // arms it.
  passesOver(): boolean {
    if (this.enabled && this.late && this.seen && !this.armed) {
      this.armed = true
      return true
    }
    return false
  }
}

// The --stop-on-nonmatch state for one haystack.
export function nonmatchStop(f: RgFlags): NonmatchStop {
  return new NonmatchStop(f.stopOnNonmatch, f.invert && !f.passthru)
}

async function readRecord(
  lines: AsyncLineIterator,
  f: RgFlags,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const [raw, terminated] = await lines.readUntil(f.nullData ? 0 : 10, signal)
  return terminated || raw.length > 0 ? raw : null
}

// Read no further than the first selected line (-q, -l and
// --files-without-match need only that one bit).
async function listing(
  lines: AsyncLineIterator,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  signal?: AbortSignal,
): Promise<void> {
  for (
    let raw = await readRecord(lines, f, signal);
    raw !== null;
    raw = await readRecord(lines, f, signal)
  ) {
    if (selects(pat, decodeLine(raw), f.invert)) {
      tally.selected = true
      return
    }
  }
}

// -c's selected lines, or --count-matches' matches, up to -m.
async function count(
  lines: AsyncLineIterator,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0
  let selected = 0
  const stop = nonmatchStop(f)
  for (
    let raw = await readRecord(lines, f, signal);
    raw !== null;
    raw = await readRecord(lines, f, signal)
  ) {
    const text = decodeLine(raw)
    if (!selects(pat, text, f.invert)) {
      if (stop.armed) break
      stop.passesOver()
      continue
    }
    stop.select()
    selected += 1
    tally.selected = true
    if (f.onlyMatching && f.countOnly) {
      // -o -c counts matches, which an inverted selection has none of, and
      // still lists the input (ripgrep 14.1.1).
      if (!f.invert) total += [...rustMatches(pat, text)].length
    } else if (f.countMatches && !f.invert) {
      total += [...rustMatches(pat, text)].length
    } else {
      total += 1
    }
    if (f.maxCount !== null && selected >= f.maxCount) break
  }
  return total
}

/**
 * The printed lines of one haystack, context and all. Selected lines and
 * their context, grouped the way ripgrep groups them, with the context
 * separator between groups. It holds only the last -B lines nothing has
 * printed yet, and stops reading once -m has selected its last line and
 * that line's trailing context is out; a trailing line that would be
 * selected prints as selected, still counted as context. --passthru prints
 * every line up to the -m-th selected one and separates nothing.
 * --stop-on-nonmatch ends the file where `NonmatchStop` says.
 */
async function* printedLines(
  lines: AsyncLineIterator,
  printer: RgPrinter,
  pat: RegExp,
  f: RgFlags,
  tally: Tally,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const context = printsContext(f)
  const keep = context ? f.contextBefore : 0
  const held: [number, number, string][] = []
  const budget = new YieldBudget(signal)
  let index = -1
  let position = 0
  let selected = 0
  let lastPrinted = -1
  let afterLeft = 0
  const stop = nonmatchStop(f)
  for (
    let raw = await readRecord(lines, f, signal);
    raw !== null;
    raw = await readRecord(lines, f, signal)
  ) {
    index += 1
    const start = position
    position += raw.byteLength + 1
    const text = decodeLine(raw)
    const hit = selects(pat, text, f.invert)
    if (!hit && stop.armed) {
      // The line that stops the file still prints as the context it is.
      if (f.passthru || afterLeft > 0) yield* printer.context(index, start, text)
      return
    }
    if (!hit && stop.passesOver()) {
      if (keep > 0) {
        held.push([index, start, text])
        if (held.length > keep) held.shift()
      }
      continue
    }
    const selecting = f.maxCount === null || selected < f.maxCount
    let records: Iterable<Uint8Array> = []
    if (hit && selecting) {
      stop.select()
      selected += 1
      tally.selected = true
      if (context) {
        const first = held[0]?.[0] ?? index
        if (lastPrinted >= 0 && first > lastPrinted + 1 && f.contextSeparator !== null) {
          yield encodeLine(f.contextSeparator + (f.nullData ? '\0' : '\n'))
        }
        for (const [i, s, t] of held) yield* printer.context(i, s, t)
        held.length = 0
        afterLeft = f.contextAfter
      }
      records = printer.selected(index, start, text)
      lastPrinted = index
    } else if (f.passthru) {
      if (!selecting) return
      records = printer.context(index, start, text)
      lastPrinted = index
    } else if (afterLeft > 0) {
      records = hit ? printer.selected(index, start, text) : printer.context(index, start, text)
      afterLeft -= 1
      lastPrinted = index
    } else if (keep > 0) {
      held.push([index, start, text])
      if (held.length > keep) held.shift()
    }
    for (const chunk of records) {
      yield chunk
      await budget.run()
    }
    await budget.run()
    if (f.maxCount !== null && selected >= f.maxCount && afterLeft === 0) return
  }
}

/**
 * One haystack's output as ripgrep prints it, read no further than the
 * answer needs: -q, -l and --files-without-match stop at the first selected
 * line, and -m at its last one and that line's trailing context, so a pipe
 * that goes on past the answer is never waited on. `name` is the haystack's
 * path as printed, which -l and --files-without-match answer with; `label`
 * is the path each record leads with, null when the output names no file.
 */
export async function* searchHaystack(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  f: RgFlags,
  name: string,
  label: string | null,
  tally: Tally,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  // ripgrep selects no line at all under -m0 and prints nothing, count and
  // listing included.
  if (f.maxCount === 0) return
  const lines = new AsyncLineIterator(source)
  try {
    if (f.quiet || f.filesOnly || f.filesWithoutMatch) {
      await listing(lines, pat, f, tally, signal)
      if (!f.quiet && tally.selected === f.filesOnly) {
        yield encodeLine(name + (f.null || f.nullData ? '\0' : '\n'))
      }
      return
    }
    if (f.countOnly || f.countMatches) {
      const total = await count(lines, pat, f, tally, signal)
      if (tally.selected || f.includeZero) {
        const head = label === null ? '' : label + (f.null ? '\0' : ':')
        yield encodeLine(`${head}${String(total)}${f.nullData ? '\0' : '\n'}`)
      }
      return
    }
    const printer = new RgPrinter(f, pat, f.heading ? null : label)
    yield* printedLines(lines, printer, pat, f, tally, signal)
  } catch (error) {
    await discardStreams(source)
    throw error
  }
}
