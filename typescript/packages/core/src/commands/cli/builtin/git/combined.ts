import { getOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { FUNCNAME_START, GIT_SPACE } from './constants.ts'

// Measured against git 2.47.3 and 2.50.1. Both print a -U0 hunk that reaches
// past the last line with every count one short, so dropping a final line
// both parents had reads "@@@ -3,0 -3,0 +3,18446744073709551615 @@@". This
// prints the counts of the lines shown: "@@@ -3,1 -3,1 +3,0 @@@".
const CONTEXT = 3
const COMMENT_BYTES = 40
// How many bits of comparison rows the folding of dropped lines keeps at
// once, and how many it spends keeping the bit masks of repeated lines.
const ROW_BUDGET = 2 ** 26
const MASK_BUDGET = 2 ** 26
const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A parent line the merge dropped, and the parents (as bits) that had it. */
type Removal = [string, number]

/**
 * The result and, row by row, how each parent differs from it. Row `k` is
 * result line `k` with the parent lines dropped just before it; row
 * `result.length` holds what was dropped at the end.
 */
interface Layout {
  readonly result: readonly string[]
  /** Per result line, the parents lacking it. */
  readonly newcomers: readonly number[]
  /** Per row, the lines dropped before it. */
  readonly gaps: readonly Removal[][]
  readonly width: number
}

/** A changed row. */
interface Mark {
  readonly row: number
  /**
   * The last line its trailing context covers: `context` lines past a new
   * line, or `context` lines from the row's own line when only dropped lines
   * changed.
   */
  readonly reach: number
  /** The parent bits of each changed line. */
  readonly kinds: ReadonlySet<number>
}

/**
 * The hunks of a combined diff, one column per parent.
 *
 * Each parent is compared with the result on its own. A result line the
 * parent lacks shows `+` in its column, a line it had that the merge dropped
 * shows `-`, and lines several parents dropped at one row print once with
 * each of those parents marked.
 *
 * A hunk shows `context` lines around each changed row and takes in the next
 * changed row once their context lines meet or touch. Under `--cc` the
 * changed rows are first bunched more tightly (the next row falls within the
 * trailing context, or right after), and a bunch whose every line is new to,
 * or dropped by, the same parents, but not all of them, is taken as cleanly
 * merged and left out. Its dropped lines still count in the parents' ranges
 * where a shown hunk covers their row, as git counts them.
 *
 * @param parents - each parent's lines, newlines kept.
 * @param result - the merge result's lines, newlines kept.
 * @param dense - `--cc` rather than `-c`.
 * @param context - the requested number of context lines.
 */
export function combinedLines(
  parents: string[][],
  result: string[],
  dense: boolean,
  context = CONTEXT,
): string[] {
  const layout = compareSides(parents, result)
  let marks = changedRows(layout, context)
  if (dense) {
    const every = 2 ** layout.width - 1
    marks = bunches(marks, 0, 0)
      .filter((bunch) => conflicted(bunch, every))
      .flat()
  }
  const before = linesBefore(layout)
  const out: string[] = []
  let searched = 0
  for (const hunk of bunches(marks, context, 1)) {
    const first = Math.max((hunk[0]?.row ?? 0) - context, 0)
    let reach = -Infinity
    for (const mark of hunk) reach = Math.max(reach, mark.row, mark.reach)
    const last = Math.min(reach, result.length)
    let label: string | null = null
    for (let row = first - 1; row >= searched; row--) {
      const line = result[row] ?? ''
      if (FUNCNAME_START.test(line)) {
        label = line
        break
      }
    }
    // Row by row: a hunk can hold more rows than a call takes arguments.
    for (const line of renderHunk(layout, hunk, first, last, context, before, label)) out.push(line)
    searched = last + 1
  }
  return out
}

/** Compare every parent with the result. */
function compareSides(parents: string[][], result: string[]): Layout {
  const newcomers = new Array<number>(result.length).fill(0)
  const gaps: Removal[][] = Array.from({ length: result.length + 1 }, () => [])
  parents.forEach((lines, index) => {
    const bit = 2 ** index
    for (const [tag, lo, hi, start, stop] of getOpcodes(lines, result)) {
      if (tag === DiffOpTag.EQUAL) continue
      for (let row = start; row < stop; row++) newcomers[row] = (newcomers[row] ?? 0) | bit
      if (hi > lo) gaps[start] = coalesce(gaps[start] ?? [], lines.slice(lo, hi), bit)
    }
  })
  return { result, newcomers, gaps, width: parents.length }
}

/** Every changed row, in order. */
function changedRows(layout: Layout, context: number): Mark[] {
  const marks: Mark[] = []
  layout.gaps.forEach((dropped, row) => {
    const fresh = row < layout.result.length ? (layout.newcomers[row] ?? 0) : 0
    if (!fresh && dropped.length === 0) return
    const kinds = new Set(dropped.map(([, bits]) => bits))
    if (fresh) kinds.add(fresh)
    const reach = fresh ? row + context : row + context - 1
    marks.push({ row, reach, kinds })
  })
  return marks
}

/**
 * Split the changed rows into runs. A row joins the run before it when,
 * reaching back `lead` lines, it lands no later than right after the run's
 * last row, or `past` lines after the furthest trailing context in the run.
 */
function bunches(marks: Mark[], lead: number, past: number): Mark[][] {
  const runs: Mark[][] = []
  let end = 0
  for (const mark of marks) {
    const run = runs.at(-1)
    if (run && mark.row - lead <= end) {
      run.push(mark)
    } else {
      runs.push([mark])
      end = 0
    }
    end = Math.max(end, mark.reach + past, mark.row + 1)
  }
  return runs
}

/**
 * Whether `--cc` shows a bunch: its lines differ from different sets of
 * parents, or some line differs from all of them.
 */
function conflicted(bunch: Mark[], every: number): boolean {
  const kinds = new Set(bunch.flatMap((mark) => [...mark.kinds]))
  return kinds.size > 1 || kinds.has(every)
}

/** Per row, how many lines of each parent come before it. */
function linesBefore(layout: Layout): number[][] {
  const seen = new Array<number>(layout.width).fill(0)
  const table: number[][] = []
  layout.gaps.forEach((dropped, row) => {
    table.push([...seen])
    for (const [, bits] of dropped) {
      for (let index = 0; index < layout.width; index++)
        seen[index] = (seen[index] ?? 0) + ((bits >> index) & 1)
    }
    if (row < layout.result.length) {
      const fresh = layout.newcomers[row] ?? 0
      for (let index = 0; index < layout.width; index++)
        seen[index] = (seen[index] ?? 0) + 1 - ((fresh >> index) & 1)
    }
  })
  return table
}

/**
 * One hunk: its header, then rows `first` to `last`. A row's dropped lines
 * print when the row is one of the hunk's changes and always count. Its line
 * prints, and counts, when some change's context covers it; only under -U0
 * can a row in the middle of a hunk go without (a row that only lost lines),
 * and git's header still starts at `first`.
 */
function renderHunk(
  layout: Layout,
  hunk: Mark[],
  first: number,
  last: number,
  context: number,
  before: number[][],
  label: string | null,
): string[] {
  const width = layout.width
  const rows = new Set(hunk.map((mark) => mark.row))
  const counts = new Array<number>(width).fill(0)
  let shown = 0
  const body: string[] = []
  let pending = 0,
    covered = -1
  for (let row = first; row <= last; row++) {
    for (const [line, bits] of layout.gaps[row] ?? []) {
      for (let index = 0; index < width; index++)
        counts[index] = (counts[index] ?? 0) + ((bits >> index) & 1)
      if (rows.has(row)) body.push(columns(bits, '-', width) + eol(line))
    }
    while (pending < hunk.length && (hunk[pending]?.row ?? 0) - context <= row) {
      covered = Math.max(covered, hunk[pending]?.reach ?? 0)
      pending++
    }
    if (row >= layout.result.length || row > covered) continue
    const fresh = layout.newcomers[row] ?? 0
    for (let index = 0; index < width; index++)
      counts[index] = (counts[index] ?? 0) + 1 - ((fresh >> index) & 1)
    shown++
    body.push(columns(fresh, '+', width) + eol(layout.result[row] ?? ''))
  }
  const spans = counts
    .map((count, index) => `-${String((before[first]?.[index] ?? 0) + 1)},${String(count)}`)
    .join(' ')
  const fence = '@'.repeat(width + 1)
  const header = `${fence} ${spans} +${String(first + 1)},${String(shown)} ${fence}`
  return [header + funcname(label) + '\n', ...body]
}

/** The per-parent prefix: `sign` for each parent in `bits`. */
function columns(bits: number, sign: string, width: number): string {
  let prefix = ''
  for (let index = 0; index < width; index++) prefix += (bits >> index) & 1 ? sign : ' '
  return prefix
}

/**
 * Fold one more parent's dropped lines into a row. The lines pair with the
 * row's earlier ones along a longest common subsequence; between two pairs
 * the earlier parents' unpaired lines come first, then this parent's.
 */
function coalesce(held: Removal[], dropped: string[], bit: number): Removal[] {
  if (held.length === 0) return dropped.map((line) => [line, bit])
  const pairs = pairing(
    held.map(([line]) => bare(line)),
    dropped.map(bare),
  )
  const merged: Removal[] = []
  let old = 0,
    fresh = 0
  for (const [left, right] of [...pairs, [held.length, dropped.length] as const]) {
    for (let at = old; at < left; at++) {
      const removal = held[at]
      if (removal) merged.push(removal)
    }
    for (const line of dropped.slice(fresh, right)) merged.push([line, bit])
    const kept = held[left]
    if (kept) merged.push([kept[0], kept[1] | bit])
    old = left + 1
    fresh = right + 1
  }
  return merged
}

/**
 * A line without its newline, so a dropped final line with none still pairs
 * with the same line elsewhere.
 */
function bare(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line
}

/**
 * Index pairs of equal lines along a longest common subsequence, taken from
 * the ends inward: equal last lines pair, and where skipping a line on
 * either side keeps the longest length, the right side's line is skipped.
 * So `a b` and `b a` pair their `b`s, and `a a` and `a` pair the second `a`,
 * as git does.
 *
 * The walk needs the comparison row of every left line it passes, so rather
 * than keeping them all it keeps `budget` bits of rows and works the rest
 * out again from rows it kept: two passes over the lines while
 * `left.length * right.length ** 2` is under about `budget ** 2 / 4`, one
 * more per halving beyond that, with one extra row kept per halving.
 */
export function pairing(left: string[], right: string[], budget = ROW_BUDGET): [number, number][] {
  if (left.length === 0 || right.length === 0) return []
  const spots = new Spots(right)
  const pairs: [number, number][] = []
  trace(left, spots, 0, left.length, spots.full(), right.length, pairs, budget)
  return pairs.reverse()
}

/**
 * Where each line of `right` sits, as bit masks over `right` held in 32-bit
 * words. A line's mask is built from its positions when a row needs it; the
 * masks of lines that repeat are kept while `MASK_BUDGET` lasts. The rows a
 * stretch is walked through share one block, reused stretch after stretch.
 */
class Spots {
  readonly right: readonly string[]
  readonly width: number
  readonly words: number
  private readonly last: number
  private readonly places = new Map<string, number[]>()
  private readonly kept = new Map<string, Uint32Array>()
  private spare = MASK_BUDGET
  private scratch: Uint32Array | null = null
  private block: Uint32Array | null = null

  constructor(right: readonly string[]) {
    this.right = right
    this.width = right.length
    this.words = Math.max(Math.ceil(right.length / 32), 1)
    const unused = this.words * 32 - right.length
    this.last = unused ? 0xffffffff >>> unused : 0xffffffff
    right.forEach((line, j) => {
      const at = this.places.get(line)
      if (at) at.push(j)
      else this.places.set(line, [j])
    })
  }

  /** A fresh row with every bit of `right` set. */
  full(): Uint32Array {
    const row = new Uint32Array(this.words).fill(0xffffffff)
    row[this.words - 1] = this.last
    return row
  }

  /** `count` row views over the shared block, valid until the next call. */
  rows(count: number): Uint32Array[] {
    if (!this.block || this.block.length < count * this.words)
      this.block = new Uint32Array(count * this.words)
    const block = this.block
    return Array.from({ length: count }, (_, k) =>
      block.subarray(k * this.words, (k + 1) * this.words),
    )
  }

  /**
   * Write into `into` the row after `row` once `line` is added to the left
   * side. Bit `j` of row `i` is clear when `right[j]` lengthens the longest
   * common subsequence of `left[:i]` and `right[:j + 1]`, so a row costs a
   * pass over its words rather than over `right`.
   */
  step(row: Uint32Array, line: string, into: Uint32Array): void {
    const spots = this.mask(line)
    if (!spots) {
      into.set(row)
      return
    }
    let carry = 0
    for (let w = 0; w < this.words; w++) {
      const bits = row[w] ?? 0
      const hits = (bits & (spots[w] ?? 0)) >>> 0
      const sum = bits + hits + carry
      carry = sum > 0xffffffff ? 1 : 0
      into[w] = ((sum >>> 0) | (bits & ~hits)) >>> 0
    }
    into[this.words - 1] = ((into[this.words - 1] ?? 0) & this.last) >>> 0
    if (spots === this.scratch) this.clear(line)
  }

  /** The bits of the positions where `line` sits in `right`, or null. */
  private mask(line: string): Uint32Array | null {
    const kept = this.kept.get(line)
    if (kept) return kept
    const places = this.places.get(line)
    if (!places) return null
    const repeated = places.length > 1 && this.spare >= this.width
    if (repeated) this.spare -= this.width
    const bits = repeated
      ? new Uint32Array(this.words)
      : (this.scratch ??= new Uint32Array(this.words))
    for (const j of places) bits[j >>> 5] = ((bits[j >>> 5] ?? 0) | (1 << (j & 31))) >>> 0
    if (repeated) this.kept.set(line, bits)
    return bits
  }

  private clear(line: string): void {
    const scratch = this.scratch
    if (scratch) for (const j of this.places.get(line) ?? []) scratch[j >>> 5] = 0
  }
}

/**
 * Walk the pairing back from row `bottom` to row `top`, given row `top`'s
 * bits, and return the column it reaches row `top` at (0 once it has run out
 * of right lines). A stretch whose rows fit the budget is walked whole. A
 * longer one keeps every `stride`-th row from one pass and walks the pieces
 * from the last up, each worked out afresh from its first row; when even
 * those rows overflow half the budget, the stretch is halved first.
 */
function trace(
  left: string[],
  spots: Spots,
  top: number,
  bottom: number,
  first: Uint32Array,
  column: number,
  pairs: [number, number][],
  budget: number,
): number {
  const span = bottom - top,
    width = Math.max(spots.width, 1)
  if (span <= 1 || (span + 1) * width <= budget) {
    const rows = spots.rows(span + 1)
    rows[0]?.set(first)
    for (let i = top; i < bottom; i++) {
      const from = rows[i - top],
        into = rows[i - top + 1]
      if (from && into) spots.step(from, left[i] ?? '', into)
    }
    return walk(left, spots.right, rows, top, bottom, column, pairs)
  }
  const stride = Math.max(Math.floor(budget / (2 * width)), 1)
  if (Math.ceil(span / stride) * width > Math.floor(budget / 2)) {
    const middle = Math.floor((top + bottom) / 2)
    column = trace(
      left,
      spots,
      middle,
      bottom,
      advance(spots, left, top, middle, first),
      column,
      pairs,
      budget,
    )
    if (!column) return 0
    return trace(left, spots, top, middle, first, column, pairs, budget)
  }
  const starts = [first]
  for (let start = top + stride; start < bottom; start += stride)
    starts.push(advance(spots, left, start - stride, start, starts.at(-1) ?? first))
  while (starts.length > 0 && column) {
    const start = top + (starts.length - 1) * stride
    const stop = Math.min(start + stride, bottom)
    column = trace(left, spots, start, stop, starts.pop() ?? first, column, pairs, budget)
  }
  return column
}

/** Row `stop`'s bits, worked out from row `top`'s, in a fresh row. */
function advance(
  spots: Spots,
  left: string[],
  top: number,
  stop: number,
  row: Uint32Array,
): Uint32Array {
  let from = row.slice(),
    into = new Uint32Array(spots.words)
  for (let i = top; i < stop; i++) {
    spots.step(from, left[i] ?? '', into)
    ;[from, into] = [into, from]
  }
  return from
}

/**
 * Walk the pairing back through rows `top` to `row`, given those rows, and
 * return the column it reaches row `top` at (0 once it has run out of right
 * lines). `here` and `above` are the subsequence lengths at the current cell
 * and the one above it, kept as the walk moves so that only a change of row
 * counts bits.
 */
function walk(
  left: string[],
  right: readonly string[],
  rows: Uint32Array[],
  top: number,
  row: number,
  column: number,
  pairs: [number, number][],
): number {
  let i = row,
    j = column
  if (i === top || !j) return j
  const at = (k: number): Uint32Array => rows[k - top] ?? new Uint32Array(0)
  let here = commonLength(at(i), j),
    above = commonLength(at(i - 1), j)
  while (i > top && j) {
    const lower = at(i),
      upper = at(i - 1)
    if (left[i - 1] === right[j - 1]) {
      pairs.push([i - 1, j - 1])
      here = above - 1 + bit(upper, j - 1)
      i--
      j--
      if (i > top) above = commonLength(at(i - 1), j)
    } else if (here - 1 + bit(lower, j - 1) >= above) {
      here -= 1 - bit(lower, j - 1)
      above -= 1 - bit(upper, j - 1)
      j--
    } else {
      here = above
      i--
      if (i > top) above = commonLength(at(i - 1), j)
    }
  }
  return j
}

/** Bit `k` of a row. */
function bit(row: Uint32Array, k: number): number {
  return ((row[k >>> 5] ?? 0) >>> (k & 31)) & 1
}

/** The common-subsequence length a bit row gives `right[:upto]`. */
function commonLength(row: Uint32Array, upto: number): number {
  let ones = 0
  for (let w = 0; w * 32 < upto; w++) {
    const keep = upto - w * 32
    let bits = (row[w] ?? 0) & (keep >= 32 ? 0xffffffff : 0xffffffff >>> (32 - keep))
    bits -= (bits >>> 1) & 0x55555555
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333)
    bits = (bits + (bits >>> 4)) & 0x0f0f0f0f
    ones += Math.imul(bits, 0x01010101) >>> 24
  }
  return upto - ones
}

/**
 * The hunk header's trailing context, cut the way git cuts it: the first
 * 40 bytes up to a newline, stopping BEFORE the last non-blank byte, so the
 * context always loses its final byte.
 */
function funcname(line: string | null): string {
  if (line === null) return ''
  let head = ENC.encode(line).subarray(0, COMMENT_BYTES)
  const stop = head.findIndex((c) => c === 0x0a || c === 0x00)
  if (stop >= 0) head = head.subarray(0, stop)
  let end = 0
  head.forEach((c, i) => {
    if (!GIT_SPACE.has(c)) end = i
  })
  return end ? ' ' + DEC.decode(head.subarray(0, end)) : ''
}

function eol(line: string): string {
  return line.endsWith('\n') ? line : line + '\n'
}
