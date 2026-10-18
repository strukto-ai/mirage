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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { chunks } from '../../../io/cooperative.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { perOperand } from '../utils/operands.ts'
import { TAB_WIDTH } from '../../../utils/width.ts'
import { EOVERFLOW_REASON, ERANGE_REASON, unsignedDecimal } from '../utils/strtol.ts'
import { quoteText } from '../../quote.ts'

const ENC = new TextEncoder()
const DEFAULT_WIDTH = 75
// GNU 9.7 refuses a -w past 2500.
const WIDEST = 2500

// GNU 9.7 lays a long paragraph out a piece at a time, a piece holding at
// most 998 words and 5000 bytes of word text. It sets the piece, prints its
// first lines, and carries the words of the rest into the next piece,
// whose first line is then also weighed against the line printed
// before it. A piece that fits on one line is printed whole; `resume`
// says how many lines of a longer one are carried.
const PIECE_WORDS = 998
const PIECE_BYTES = 5000

// What a layout costs, in hundredths of a squared column. The last line laid
// out is free and every other line pays the rest. These values reproduce GNU
// 9.7's choices over the probe corpus, ties going to the shorter line.
// EACH_LINE is paid per line, OFF_GOAL per squared column a line misses the
// goal by, and UNEVEN per squared column a line differs from the one after it.
// A line ending on a word that ends a sentence earns SENTENCE_END, one ending
// on . ? or ! that ends no sentence pays FALSE_STOP, one ending on any other
// punctuation earns MARK_END, and one starting on ( [ ` ' or " earns
// OPENER_START. FIRST_ALONE and LAST_ALONE, over the word's length plus two,
// are paid for ending a line on a sentence's first word or starting one on a
// sentence's last, the paragraph's last word included. LATER is, per line, how
// much a full piece would rather stop later than earlier.
const EACH_LINE = 4900
const OFF_GOAL = 100
const UNEVEN = 50
const SENTENCE_END = -2500
const FALSE_STOP = 360000
const MARK_END = -1600
const OPENER_START = -1600
const FIRST_ALONE = 40000
const LAST_ALONE = 22500
const LATER = 9

const SPACES = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d])
const CLOSERS = new Set([0x29, 0x5d, 0x27, 0x22])
const OPENERS = new Set([0x28, 0x5b, 0x60, 0x27, 0x22])
const STOPS = new Set([0x2e, 0x3f, 0x21])
const MARKS = new Set(Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', (c) => c.charCodeAt(0)))

// The width lines stay under and the goal they aim at. GNU 9.7 aims at
// 93.5% of the width, rounded down, and with only a goal it allows ten
// columns past it. Mirrors Python's `_limits`.
function limits(width: number | null, goal: number | null): [number, number] {
  if (width === null) {
    if (goal !== null) return [goal + 10, goal]
    width = DEFAULT_WIDTH
  }
  return [width, goal ?? Math.floor((width * 187) / 200)]
}

// Blanks from column `col` up to `target`, nothing when not past it. Once
// the input has shown a tab, GNU 9.7 writes tabs wherever they take fewer
// bytes than spaces: column 7 to 9 stays two spaces, 7 to 16 becomes two
// tabs. Mirrors Python's `_pad`.
function pad(out: number[], col: number, target: number, tabs: boolean): void {
  if (tabs) {
    const stops = Math.floor(target / TAB_WIDTH) - Math.floor(col / TAB_WIDTH)
    const rest = target % TAB_WIDTH
    if (stops > 0 && stops + rest < target - col) {
      for (let i = 0; i < stops; i++) out.push(0x09)
      for (let i = 0; i < rest; i++) out.push(0x20)
      return
    }
  }
  for (let i = col; i < target; i++) out.push(0x20)
}

// One word of a paragraph and how lines may break around it. Mirrors
// Python's `_Term`.
interface Term {
  readonly chars: Uint8Array
  // Columns to the next word when both share a line.
  readonly gap: number
  readonly endsSentence: boolean
  // Ends in . ? or ! without ending a sentence.
  readonly falseStop: boolean
  readonly marked: boolean
  readonly opener: boolean
  // Follows the end of a sentence.
  readonly afterStop: boolean
}

// What ending a line between `terms[k]` and the next word costs; `final`
// says whether the last of `terms` ends the paragraph. Mirrors Python's
// `_join_cost`.
function joinCost(terms: readonly Term[], k: number, final: boolean): number {
  const left = terms[k]
  const right = terms[k + 1]
  if (left === undefined || right === undefined) return 0
  let cost = 0
  if (left.endsSentence) cost += SENTENCE_END
  else if (left.falseStop) cost += FALSE_STOP
  else if (left.marked) cost += MARK_END
  // GNU 9.7 does not count a piece's first word as a sentence's.
  else if (left.afterStop && k > 0) cost += Math.floor(FIRST_ALONE / (left.chars.length + 2))
  if (right.opener) cost += OPENER_START
  else if (right.endsSentence || (final && k + 2 === terms.length)) {
    cost += Math.floor(LAST_ALONE / (right.chars.length + 2))
  }
  return cost
}

// Choose where the lines of `terms` end, as the index one past each line's
// last word, and what each line cost as laid out. Working back from the
// last word, each word gets the cheapest way to lay out everything from it
// on, and a line is weighed against the first line of the remainder chosen
// after it. GNU 9.7 decides the same way, so a layout found this way can
// differ from the cheapest overall.
// `before` is the length of the line printed just before these words, null
// at a paragraph's start. Mirrors Python's `_plan`.
function plan(
  terms: readonly Term[],
  firstCol: number,
  restCol: number,
  width: number,
  goal: number,
  before: number | null,
  final: boolean,
): [number[], number[]] {
  const count = terms.length
  const sizes = Int32Array.from(terms, (term) => term.chars.length)
  const gaps = Int32Array.from(terms, (term) => term.gap)
  const joins = Float64Array.from({ length: Math.max(count - 1, 0) }, (_, k) =>
    joinCost(terms, k, final),
  )
  const best = new Float64Array(count + 1)
  const stop = new Int32Array(count + 1).fill(count)
  const reach = new Int32Array(count + 1)
  for (let start = count - 1; start >= 0; start--) {
    let length = start === 0 ? firstCol : restCol
    for (let end = start + 1; end <= count; end++) {
      if (end > start + 1) length += gaps[end - 2] ?? 0
      length += sizes[end - 1] ?? 0
      if (end > start + 1 && length >= width) break
      let cost = best[end] ?? 0
      if (end < count) {
        cost += EACH_LINE + OFF_GOAL * (goal - length) ** 2
        cost += joins[end - 1] ?? 0
        if ((stop[end] ?? count) < count) cost += UNEVEN * (length - (reach[end] ?? 0)) ** 2
      }
      if (start === 0 && before !== null) cost += UNEVEN * (length - before) ** 2
      if (end === start + 1 || cost < (best[start] ?? 0)) {
        best[start] = cost
        stop[start] = end
        reach[start] = length
      }
    }
  }
  const ends: number[] = []
  const costs: number[] = []
  let at = 0
  while (at < count) {
    const next = stop[at] ?? count
    costs.push((best[at] ?? 0) - (best[next] ?? 0))
    at = next
    ends.push(at)
  }
  return [ends, costs]
}

// Where a full piece stops printing: the word its kept lines start at,
// given its lines as `plan` chose them, two or more, and what each cost.
// GNU 9.7 keeps the lines from the one that weighs least as a first line:
// its own cost without the break it ends on, but with the break before
// it, the piece's last line counting as a perfect line, plus a little for
// every line still after it. Ties go to the earlier line. Mirrors Python's
// `_resume`.
function resume(terms: readonly Term[], ends: readonly number[], costs: readonly number[]): number {
  const last = ends.length - 1
  let keep = ends[last - 1] ?? 0
  let lowest: number | null = null
  for (let line = 1; line <= last; line++) {
    const start = ends[line - 1] ?? 0
    let weight =
      line === last ? EACH_LINE : (costs[line] ?? 0) - joinCost(terms, (ends[line] ?? 0) - 1, false)
    weight += joinCost(terms, start - 1, false) + LATER * (last - line)
    if (lowest === null || weight < lowest) {
      lowest = weight
      keep = start
    }
  }
  return keep
}

// Lines joined so far, and what is left of them to print. Mirrors Python's
// `_Paragraph`.
interface Paragraph {
  // Columns of blanks before the prefix, which every line must share.
  readonly lead: number
  readonly firstCol: number
  restCol: number
  lines: number
  terms: Term[]
  size: number
  // Length of the last line printed, for the next piece's first line.
  last: number | null
  // Whether the word before the next one ended a sentence.
  afterStop: boolean
}

// Reflows one input stream, a paragraph at a time. A paragraph is printed
// once a line arrives that does not continue it. GNU 9.7 has read that
// line's leading blanks, prefix and indent by then, so a tab among them
// already counts when the paragraph prints. Mirrors Python's `_Layout`.
class Layout {
  private readonly floor: number
  private readonly mark: Uint8Array
  private readonly trail: number
  private readonly prefixed: boolean
  private tabs = false
  // Where the last paragraph's later lines started; -t starts a one-line
  // paragraph's from there.
  private hung = 0
  private para: Paragraph | null = null
  // The input line being read: 'start' until its text or its end, then
  // 'copy' for a line printed as it stands or 'text' for one whose words
  // join a paragraph; the column read to, whether the blanks just read held
  // a tab, the columns of blanks before the prefix and the bytes of the
  // prefix matched, -1 before it.
  private mode: 'start' | 'copy' | 'text' = 'start'
  private col = 0
  private tab = false
  private lead = 0
  private matched = -1
  // The word being read, the column it starts in and the column after it,
  // -1 while it goes on.
  private word: number[] = []
  private start = 0
  private after = -1

  constructor(
    private readonly width: number,
    private readonly goal: number,
    prefix: string | null,
    private readonly splitOnly: boolean,
    private readonly tagged: boolean,
    private readonly crown: boolean,
    private readonly uniform: boolean,
  ) {
    const typed = ENC.encode(prefix ?? '')
    // GNU 9.7 reads -p ' # ' as '#' at least one column in and followed by
    // at least one blank column; those spaces are not matched as typed, so
    // '\t#\tx' qualifies. A tab in a prefix is matched as typed and counted
    // as one column.
    let skip = 0
    while (skip < typed.length && typed[skip] === 0x20) skip++
    let keep = typed.length
    while (keep > skip && typed[keep - 1] === 0x20) keep--
    this.floor = skip
    this.mark = typed.slice(skip, keep)
    this.trail = typed.length - keep
    this.prefixed = typed.length > 0
  }

  private static append(
    out: number[],
    bytes: Uint8Array | readonly number[],
    from = 0,
    to = bytes.length,
  ): void {
    for (let i = from; i < to; i++) out.push(bytes[i] ?? 0)
  }

  // Take more input, or null at its end, and return what it settles. Words
  // are read as they come, so a full piece prints before its line ends, as
  // GNU 9.7 prints one.
  feed(data: Uint8Array | null): Uint8Array {
    const out: number[] = []
    if (data === null) {
      if (this.mode === 'start' && this.col > 0) this.decide(true, false, out)
      this.end(false, out)
      this.close(out)
      return Uint8Array.from(out)
    }
    let pos = 0
    while (pos < data.length) {
      if (this.mode === 'start') pos = this.head(data, pos, out)
      else if (this.mode === 'text') pos = this.text(data, pos, out)
      else {
        const newline = data.indexOf(0x0a, pos)
        if (newline < 0) {
          Layout.append(out, data, pos)
          break
        }
        Layout.append(out, data, pos, newline)
        this.end(true, out)
        pos = newline + 1
      }
    }
    return Uint8Array.from(out)
  }

  // Read a line's leading blanks, prefix and indent from `pos`, and return
  // where reading stopped, at the line's text or past its end.
  private head(data: Uint8Array, pos: number, out: number[]): number {
    const mark = this.mark
    while (pos < data.length) {
      const byte = data[pos] ?? 0
      if (byte === 0x0a) {
        this.decide(true, true, out)
        this.end(true, out)
        return pos + 1
      }
      if (this.matched >= 0 && this.matched < mark.length) {
        if (byte !== mark[this.matched]) {
          this.decide(false, false, out)
          return pos
        }
        this.matched += 1
        this.col += 1
      } else if (byte === 0x20) this.col += 1
      else if (byte === 0x09) {
        this.col += TAB_WIDTH - (this.col % TAB_WIDTH)
        this.tab = true
      } else if (this.matched < 0 && mark.length > 0) {
        this.lead = this.col
        this.matched = 0
        continue
      } else {
        this.decide(false, false, out)
        return pos
      }
      pos += 1
    }
    return pos
  }

  // Settle what the line whose head was just read is; `bare` says whether
  // it ended within its head, `ended` whether it ended in a newline.
  private decide(bare: boolean, ended: boolean, out: number[]): void {
    const col = this.col
    const tab = this.tab
    const mark = this.mark
    let lead: number
    if (!this.prefixed) {
      if (bare) {
        this.interrupt(tab, out)
        out.push(0x0a)
        return
      }
      lead = 0
    } else if (mark.length === 0) {
      // A prefix of only spaces: GNU 9.7 wants that many columns of leading
      // blanks, and more than that on a line of nothing else. It prints
      // them as the prefix and the rest as indent.
      const floor = this.floor
      if (col < floor || (bare && col === floor)) {
        this.interrupt(tab, out)
        if (!bare) {
          pad(out, 0, col, this.tabs)
          this.mode = 'copy'
        } else if (ended) out.push(0x0a)
        return
      }
      if (bare) {
        this.interrupt(tab, out)
        pad(out, 0, floor, this.tabs)
        out.push(0x0a)
        return
      }
      lead = floor
    } else if (this.matched < mark.length) {
      // Copied with its leading blanks rewritten; a line of only blanks
      // prints empty, and a last line without a newline stays without.
      const matched = Math.max(this.matched, 0)
      lead = matched > 0 ? this.lead : col
      this.interrupt(tab, out)
      if (matched > 0 || !bare) {
        pad(out, 0, lead, this.tabs)
        Layout.append(out, mark, 0, matched)
        this.mode = 'copy'
      } else if (ended) out.push(0x0a)
      return
    } else {
      lead = this.lead
      const after = lead + mark.length
      if (lead < this.floor || col - after < this.trail) {
        // Copied too, but GNU 9.7 also rewrites the blanks it read past the
        // prefix, and ends a bare prefix with a newline.
        this.interrupt(tab, out)
        pad(out, 0, lead, this.tabs)
        Layout.append(out, mark)
        if (bare) {
          out.push(0x0a)
          return
        }
        pad(out, after, col, this.tabs)
        this.mode = 'copy'
        return
      }
      if (bare) {
        this.interrupt(tab, out)
        pad(out, 0, lead, this.tabs)
        Layout.append(out, mark)
        out.push(0x0a)
        return
      }
    }
    this.tabs ||= tab
    const para = this.para
    if (para !== null && this.joins(para, lead, col)) para.lines += 1
    else {
      this.close(out)
      this.para = {
        lead,
        firstCol: col,
        restCol: this.hang(col),
        lines: 1,
        terms: [],
        size: 0,
        last: null,
        afterStop: false,
      }
    }
    this.mode = 'text'
    this.tab = false
  }

  // Finish the input line being read; `ended` says whether it ended in a
  // newline.
  private end(ended: boolean, out: number[]): void {
    if (this.mode === 'copy' && ended) out.push(0x0a)
    else if (this.mode === 'text') this.finish(true, out)
    this.mode = 'start'
    this.col = 0
    this.tab = false
    this.matched = -1
  }

  // End the paragraph before a line printed as it stands; `tab` says whether
  // the blanks read from that line held a tab.
  private interrupt(tab: boolean, out: number[]): void {
    this.tabs ||= tab
    this.close(out)
  }

  // Where a paragraph's later lines start until its second line says. Under
  // -t alone, GNU 9.7 starts them where the last paragraph's later lines
  // started, unless that is the first line's own indent: then in column 3
  // when that is column 0, and in column 0 otherwise.
  private hang(indent: number): number {
    if (!this.tagged || this.crown || this.splitOnly) return indent
    if (this.hung === indent) return indent === 0 ? 3 : 0
    return this.hung
  }

  // Whether a line with these blanks continues `para`.
  private joins(para: Paragraph, lead: number, indent: number): boolean {
    if (this.splitOnly || lead !== para.lead) return false
    if (para.lines > 1) return indent === para.restCol
    // The second line sets where all lines after the first start.
    if (this.crown || (this.tagged && indent !== para.firstCol)) {
      para.restCol = indent
      return true
    }
    return !this.tagged && indent === para.firstCol
  }

  // Read words from `pos` up to the line's end, and return where reading
  // stopped, past the line's end or the input's. A word runs to the next
  // space, tab, newline, vertical tab, form feed or carriage return; only
  // spaces and tabs part it from the next, so 'a\rb' holds the words 'a'
  // and '\rb'.
  private text(data: Uint8Array, pos: number, out: number[]): number {
    while (pos < data.length) {
      const byte = data[pos] ?? 0
      if (byte === 0x0a) {
        this.end(true, out)
        return pos + 1
      }
      if (this.word.length > 0 && this.after < 0) {
        let stop = pos
        while (stop < data.length && !SPACES.has(data[stop] ?? 0)) stop++
        this.grow(data, pos, stop, out)
        if (stop < data.length) this.after = this.col
        pos = stop
        continue
      }
      if (byte === 0x20) this.col += 1
      else if (byte === 0x09) {
        this.col += TAB_WIDTH - (this.col % TAB_WIDTH)
        this.tab = true
      } else {
        if (this.word.length > 0) this.finish(false, out)
        this.start = this.col
        this.grow(data, pos, pos + 1, out)
      }
      pos += 1
    }
    return pos
  }

  // Add `data` from `from` to `to` to the word being read. GNU 9.7 prints a
  // piece as soon as the word overflows it, before reading the rest of the
  // word or the blanks after it.
  private grow(data: Uint8Array, from: number, to: number, out: number[]): void {
    Layout.append(this.word, data, from, to)
    this.col += to - from
    const para = this.para
    if (para === null) return
    while (para.size + this.word.length > PIECE_BYTES) {
      if (para.terms.length > 0) {
        this.flush(para, this.start, out)
        continue
      }
      // A word filling a whole piece: GNU 9.7 prints as much of it as a
      // piece holds, with no indent and no newline, and goes on with the
      // rest of it as a word of its own, in the column the word started in.
      Layout.append(out, this.word, 0, PIECE_BYTES)
      this.word.splice(0, PIECE_BYTES)
      this.col -= PIECE_BYTES
    }
  }

  // Add the word just read, and the blanks after it, to the paragraph;
  // `last` says whether the word ends its line.
  private finish(last: boolean, out: number[]): void {
    const para = this.para
    if (para === null) return
    const chars = Uint8Array.from(this.word)
    if (this.after < 0) this.after = this.col
    let gap = this.col - this.after
    let core = chars.length
    while (core > 0 && CLOSERS.has(chars[core - 1] ?? 0)) core--
    const stop = core > 0 && STOPS.has(chars[core - 1] ?? 0)
    const ends = stop && (last || gap >= 2)
    if (last || this.uniform) gap = ends ? 2 : 1
    if (para.terms.length >= PIECE_WORDS) {
      // GNU 9.7 has read this word's trailing blanks by then.
      this.tabs ||= this.tab
      this.flush(para, this.col, out)
    }
    para.terms.push({
      chars,
      gap,
      endsSentence: ends,
      falseStop: stop && !ends,
      marked: MARKS.has(chars[chars.length - 1] ?? 0),
      opener: OPENERS.has(chars[0] ?? 0),
      afterStop: para.afterStop,
    })
    para.afterStop = ends
    para.size += chars.length
    this.tabs ||= this.tab
    this.tab = false
    this.word = []
    this.after = -1
  }

  // Print a full piece of `para`, `col` being the input column read to.
  // Under -c or -t, GNU 9.7 then starts the paragraph's later lines,
  // whatever its second line said, in that column.
  private flush(para: Paragraph, col: number, out: number[]): void {
    if ((this.crown || this.tagged) && !this.splitOnly) para.restCol = col
    this.settle(para, out, false)
  }

  private close(out: number[]): void {
    const para = this.para
    if (para === null) return
    if (para.lines === 1 && !this.splitOnly) {
      // A paragraph of one line, its later indent settled now: -c takes the
      // first line's, -t keeps the one it has unless that is the first
      // line's own.
      if (this.crown) para.restCol = para.firstCol
      else if (this.tagged && para.restCol === para.firstCol) {
        para.restCol = para.firstCol === 0 ? 3 : 0
      }
    }
    this.settle(para, out, true)
    this.hung = para.restCol
    this.para = null
  }

  // Print what `para` holds, but for the lines a full piece carries; `final`
  // says whether the paragraph has ended.
  private settle(para: Paragraph, out: number[], final: boolean): void {
    const terms = para.terms
    if (terms.length === 0) return
    // GNU 9.7 starts every piece's first line in the first line's column.
    const [ends, costs] = plan(
      terms,
      para.firstCol,
      para.restCol,
      this.width,
      this.goal,
      para.last,
      final,
    )
    const keep = final || ends.length === 1 ? 0 : resume(terms, ends, costs)
    let start = 0
    for (const end of ends) {
      if (keep > 0 && end > keep) break
      const col = start > 0 ? para.restCol : para.firstCol
      para.last = this.print(para, start, end, col, out)
      start = end
    }
    terms.splice(0, keep > 0 ? keep : terms.length)
    para.size = terms.reduce((sum, term) => sum + term.chars.length, 0)
  }

  // Print one line of `para`, words `start` to `end` with the text in column
  // `col`, and return its length as laid out. A -t indent left of the
  // prefix's end counts as given, though the text then starts right after
  // the prefix.
  private print(para: Paragraph, start: number, end: number, col: number, out: number[]): number {
    let here = 0
    if (this.prefixed) {
      pad(out, 0, para.lead, this.tabs)
      Layout.append(out, this.mark)
      here = para.lead + this.mark.length
    }
    pad(out, here, col, this.tabs)
    here = Math.max(here, col)
    let length = col
    let gap: number | null = null
    for (const term of para.terms.slice(start, end)) {
      if (gap !== null) {
        pad(out, here, here + gap, this.tabs)
        here += gap
        length += gap
      }
      Layout.append(out, term.chars)
      here += term.chars.length
      length += term.chars.length
      gap = term.gap
    }
    out.push(0x0a)
    return length
  }
}

interface FmtFlags {
  readonly width: number | null
  readonly goal: number | null
  readonly prefix: string | null
  readonly splitOnly: boolean
  readonly tagged: boolean
  readonly crown: boolean
  readonly uniform: boolean
}

// fmt's refusal of a -w value, past its range a range error. Mirrors Python's
// `_width_refusal`.
function widthRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${ERANGE_REASON}`
  return `fmt: invalid width: '${quoteText(text)}'${reason}`
}

// fmt's refusal of a -g value, past the width too large. Mirrors Python's
// `_goal_refusal`.
function goalRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${EOVERFLOW_REASON}`
  return `fmt: invalid width: '${quoteText(text)}'${reason}`
}

function parseFlags(bag: Record<string, FlagValue>): FmtFlags {
  const fl = new FlagView(bag, specOf('fmt'))
  // GNU 9.7 takes -w as a decimal from 0 to 2500, then -g as one from 0 to
  // that width.
  const width = fl.asNumber('width', unsignedDecimal, widthRefusal, {
    low: 0n,
    high: BigInt(WIDEST),
  })
  const goal = fl.asNumber('goal', unsignedDecimal, goalRefusal, {
    low: 0n,
    high: width ?? BigInt(DEFAULT_WIDTH),
  })
  return {
    width: width === undefined ? null : Number(width),
    goal: goal === undefined ? null : Number(goal),
    prefix: fl.asStr('prefix') ?? null,
    splitOnly: fl.asBool('split_only'),
    tagged: fl.asBool('tagged_paragraph'),
    crown: fl.asBool('crown_margin'),
    uniform: fl.asBool('uniform_spacing'),
  }
}

export function fmtGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  const [maxWidth, goalWidth] = limits(parsed.width, parsed.goal)
  const { prefix, splitOnly, tagged, crown, uniform } = parsed
  const each = (source: ByteSource) =>
    fmtStream(source, new Layout(maxWidth, goalWidth, prefix, splitOnly, tagged, crown, uniform))
  const io = new IOResult()
  return [perOperand(paths, stream, ctx.stdin, io, 'fmt', each), io]
}

async function* fmtStream(source: ByteSource, layout: Layout): AsyncIterable<Uint8Array> {
  for await (const part of chunks(source)) {
    const settled = layout.feed(part)
    if (settled.length > 0) yield settled
  }
  const settled = layout.feed(null)
  if (settled.length > 0) yield settled
}
