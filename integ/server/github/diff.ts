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

import type { JsonValue } from '../kit/typescript/index.ts'
import { blobSha } from './wire.ts'
import type { Tree } from './store.ts'

// git's defaults: three lines of context, a blob is binary when its first
// 8000 bytes hold a NUL, and a hunk header carries at most 80 bytes of the
// line it is found under.
const CONTEXT = 3
const BINARY_PROBE = 8000
const FUNC_LINE_BYTES = 80

// A short object id, as a repository this small abbreviates one. Measured
// against GitHub (2026-09-29): octocat/git-consortium's diffs print seven hex
// digits; a repository with far more objects prints more.
const ABBREV = 7
const NO_BLOB = '0'.repeat(ABBREV)

type ChangeStatus = 'added' | 'removed' | 'modified' | 'renamed'

/**
 * One path that differs between two trees, as git reports it. Its hunks hold
 * the file's bytes, one character each.
 */
export interface FileChange {
  filename: string
  previous: string | null
  status: ChangeStatus
  before: string
  after: string
  binary: boolean
  additions: number
  deletions: number
  hunks: string[]
}

interface Op {
  kind: ' ' | '-' | '+'
  text: string
}

// Each line keeps its terminator, so a last line with no newline differs from
// the same text with one, which is how git compares them. A line is its bytes,
// one character each, because git diffs bytes: decoding as UTF-8 would
// replace any other encoding's bytes before the diff saw them.
function linesOf(data: Buffer): string[] {
  const text = data.toString('latin1')
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) {
      out.push(text.slice(at))
      break
    }
    out.push(text.slice(at, nl + 1))
    at = nl + 1
  }
  return out
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, BINARY_PROBE).includes(0)
}

// One side of a line diff: its lines, each numbered by its content so that
// comparing two lines compares two numbers, and which of them the diff changed.
interface Side {
  lines: string[]
  ids: Int32Array
  changed: Uint8Array
}

function sidesOf(a: string[], b: string[]): [Side, Side] {
  const ids = new Map<string, number>()
  const id = (line: string): number => {
    const known = ids.get(line)
    if (known !== undefined) return known
    ids.set(line, ids.size)
    return ids.size - 1
  }
  const side = (lines: string[]): Side => ({
    lines,
    ids: Int32Array.from(lines, id),
    changed: new Uint8Array(lines.length),
  })
  return [side(a), side(b)]
}

function countsOf(ids: Int32Array): Map<number, number> {
  const out = new Map<number, number>()
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1)
  return out
}

// Before it searches, git sets aside the lines it will call changed whatever
// the search finds: a line the other side never holds, and a line the other
// side holds often that stands among such lines. As measured against git
// 2.50's output, often is 4 copies below 16 lines on this side, doubling each
// time the length quadruples (8 below 64, 16 below 256), up to 1024; a side
// too short for the run below never sets a line aside this way. Such a line
// is set aside when the lines around it, read each way to the nearest line
// with an ordinary count, no further than 100 lines and not into the two
// files' matching ends, hold missing lines on both sides, and more of them
// than three times one more than the often-held lines there, itself included.
// That is why git's diff of a new block with blank lines in it can be longer
// than the shortest one.
const MISSING = 0
const ORDINARY = 1
const OFTEN = 2
const OFTEN_CAP = 1024
const RUN_REACH = 100

function oftenFrom(length: number): number {
  let often = 1
  for (let rest = length; rest > 0; rest = Math.floor(rest / 4)) often *= 2
  return Math.min(often, OFTEN_CAP)
}

function amidMissing(kinds: Uint8Array, at: number): boolean {
  let missing = 0
  let often = 1
  for (const step of [-1, 1]) {
    let near = 0
    for (let i = at + step, read = 0; read < RUN_REACH; i += step, read += 1) {
      const kind = kinds[i]
      if (kind === MISSING) near += 1
      else if (kind === OFTEN) often += 1
      else break
    }
    if (near === 0) return false
    missing += near
  }
  return missing > 3 * (often + 1)
}

// The lines of `side` between `from` and `to` that the search sees, by index.
// The rest of that span is marked changed.
function searchedLines(
  side: Side,
  others: Map<number, number>,
  from: number,
  to: number,
): number[] {
  const often = oftenFrom(side.lines.length)
  const kinds = new Uint8Array(to - from)
  for (let i = from; i < to; i += 1) {
    const count = others.get(side.ids[i] ?? -1) ?? 0
    kinds[i - from] = count === 0 ? MISSING : count >= often ? OFTEN : ORDINARY
  }
  const out: number[] = []
  for (let i = from; i < to; i += 1) {
    const kind = kinds[i - from]
    if (kind === ORDINARY || (kind === OFTEN && !amidMissing(kinds, i - from))) out.push(i)
    else side.changed[i] = 1
  }
  return out
}

// The searched lines of both sides, the furthest-reaching paths along each
// diagonal k = x - y, and which searched lines the search changed.
interface Search {
  a: Int32Array
  b: Int32Array
  forward: Int32Array
  reverse: Int32Array
  offset: number
  goneA: Uint8Array
  goneB: Uint8Array
}

// Myers' middle snake (1986, "An O(ND) Difference Algorithm and Its
// Variations", section 4b) for the box a[aLo..aHi) by b[bLo..bHi): paths of D
// edits grown from the top-left corner and from the bottom-right one, D going
// up by one each round, until a forward path and a reverse one overlap on a
// diagonal. The snake found there splits the box. The paper walks a round's
// diagonals from the lowest; git's output shows them walked from the highest,
// which picks a different edit among the shortest. The answer is the snake's
// two ends, as absolute line numbers: x, y, u, v, or null once MOST_ROUNDS
// rounds pass without the paths meeting, so a file reordered end to end costs
// a bounded time.
const MOST_ROUNDS = 4096

function middleSnake(
  s: Search,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number, number, number] | null {
  const { a, b, forward: fw, reverse: rv, offset } = s
  const n = aHi - aLo
  const m = bHi - bLo
  const delta = n - m
  const odd = (delta & 1) !== 0
  const at = (v: Int32Array, k: number): number => v[k + offset] ?? 0
  const same = (x: number, y: number): boolean => a[aLo + x] === b[bLo + y]
  let x0 = 0
  while (x0 < n && x0 < m && same(x0, x0)) x0 += 1
  fw[offset] = x0
  let r0 = n
  while (r0 > 0 && r0 - delta > 0 && same(r0 - 1, r0 - delta - 1)) r0 -= 1
  rv[delta + offset] = r0
  let fLo = 0
  let fHi = 0
  let rLo = delta
  let rHi = delta
  for (let round = 0; round < MOST_ROUNDS; round += 1) {
    let lo = n + 1
    let hi = -m - 1
    for (let k = fHi < n ? fHi + 1 : fHi - 1; k >= (fLo > -m ? fLo - 1 : fLo + 1); k -= 2) {
      let x = -1
      if (k - 1 >= fLo && k - 1 <= fHi && at(fw, k - 1) < n) x = at(fw, k - 1) + 1
      if (k + 1 >= fLo && k + 1 <= fHi && at(fw, k + 1) - k <= m) x = Math.max(x, at(fw, k + 1))
      if (x < 0) continue
      const sx = x
      while (x < n && x - k < m && same(x, x - k)) x += 1
      fw[k + offset] = x
      lo = Math.min(lo, k)
      hi = Math.max(hi, k)
      if (odd && k >= rLo && k <= rHi && x >= at(rv, k)) {
        return [aLo + sx, bLo + sx - k, aLo + x, bLo + x - k]
      }
    }
    fLo = lo
    fHi = hi
    lo = n + 1
    hi = -m - 1
    for (let k = rHi < n ? rHi + 1 : rHi - 1; k >= (rLo > -m ? rLo - 1 : rLo + 1); k -= 2) {
      let x = n + 1
      if (k + 1 >= rLo && k + 1 <= rHi && at(rv, k + 1) > 0) x = at(rv, k + 1) - 1
      if (k - 1 >= rLo && k - 1 <= rHi && at(rv, k - 1) - k >= 0) x = Math.min(x, at(rv, k - 1))
      if (x > n) continue
      const ex = x
      while (x > 0 && x - k > 0 && same(x - 1, x - k - 1)) x -= 1
      rv[k + offset] = x
      lo = Math.min(lo, k)
      hi = Math.max(hi, k)
      if (!odd && k >= fLo && k <= fHi && x <= at(fw, k)) {
        return [aLo + x, bLo + x - k, aLo + ex, bLo + ex - k]
      }
    }
    rLo = lo
    rHi = hi
  }
  return null
}

// The shortest edit of a box: its matching ends taken off first, then a side
// left empty is all inserted or all removed, and any other box is split at
// its middle snake and each half searched in turn. A box whose search gives
// up is all removed and all inserted; neither half of a split needs more
// edits than the box did, so only the first box can give up.
function searchBox(s: Search, aFrom: number, aTo: number, bFrom: number, bTo: number): void {
  let aLo = aFrom
  let aHi = aTo
  let bLo = bFrom
  let bHi = bTo
  while (aLo < aHi && bLo < bHi && s.a[aLo] === s.b[bLo]) {
    aLo += 1
    bLo += 1
  }
  while (aLo < aHi && bLo < bHi && s.a[aHi - 1] === s.b[bHi - 1]) {
    aHi -= 1
    bHi -= 1
  }
  if (aLo === aHi) s.goneB.fill(1, bLo, bHi)
  else if (bLo === bHi) s.goneA.fill(1, aLo, aHi)
  else {
    const snake = middleSnake(s, aLo, aHi, bLo, bHi)
    if (snake === null) {
      s.goneA.fill(1, aLo, aHi)
      s.goneB.fill(1, bLo, bHi)
    } else {
      const [x, y, u, v] = snake
      searchBox(s, aLo, x, bLo, y)
      searchBox(s, u, aHi, v, bHi)
    }
  }
}

// How git weighs an edge of a run that could sit at several places, measured
// against git 2.50's output. A line's indent counts a space as one column and
// a tab as far as the next multiple of eight, skips carriage returns, ends at
// any other byte and stops at 200; a line of nothing else is blank. Blank
// lines are counted up to 20 each way.
const BLANK = -1
const MOST_INDENT = 200
const MOST_BLANKS = 20

function indentOf(line: string): number {
  let indent = 0
  for (const c of line) {
    if (c === ' ') indent += 1
    else if (c === '\t') indent += 8 - (indent % 8)
    else if (c !== '\r' && c !== '\n') return indent
    if (indent >= MOST_INDENT) return MOST_INDENT
  }
  return BLANK
}

interface Score {
  level: number
  penalty: number
}

// The edge just above `lines[at]`. Its level is that line's indent, or the
// next nonblank line's when it is blank. Each blank line above the edge
// counts -30, and each from the edge down -24; the end of the file -3 and the
// start of it +1. Against the nearest nonblank line above, a deeper level
// costs -4, or 10 with blank lines around the edge, and a shallower one 23,
// or 24 when the line after it goes deeper again, or 17 with blank lines
// around.
function edgeAt(lines: string[], at: number, score: Score): void {
  const end = at >= lines.length
  const here = end ? BLANK : indentOf(lines[at] ?? '')
  let above = BLANK
  let blanksAbove = 0
  for (let i = at - 1; i >= 0; i -= 1) {
    above = indentOf(lines[i] ?? '')
    if (above !== BLANK) break
    blanksAbove += 1
    if (blanksAbove === MOST_BLANKS) {
      above = 0
      break
    }
  }
  let below = BLANK
  let blanksBelow = 0
  for (let i = at + 1; i < lines.length; i += 1) {
    below = indentOf(lines[i] ?? '')
    if (below !== BLANK) break
    blanksBelow += 1
    if (blanksBelow === MOST_BLANKS) {
      below = 0
      break
    }
  }
  const blanksFrom = here === BLANK && !end ? 1 + blanksBelow : 0
  const level = here === BLANK ? below : here
  let penalty = -30 * blanksAbove - 24 * blanksFrom
  if (end) penalty -= 3
  if (above === BLANK && blanksAbove === 0) penalty += 1
  if (level !== BLANK && above !== BLANK) {
    const blanks = blanksAbove + blanksFrom > 0
    if (level > above) penalty += blanks ? 10 : -4
    else if (level < above) penalty += blanks ? 17 : below > level ? 24 : 23
  }
  score.level += level
  score.penalty += penalty
}

// A lower level wins unless its penalty is higher by more than 60; at one
// level, the lower penalty wins.
function weigh(a: Score, b: Score): number {
  return 60 * Math.sign(a.level - b.level) + a.penalty - b.penalty
}

// Where a run of `size` changed lines that can end anywhere from `top` to
// `bottom` ends, by its two edges: git reads its places from the highest to
// the lowest, only the lowest size + 2 of them and none more than 100 lines
// above the lowest, and moves to each one that weighs no worse than the best
// before it.
const PLACE_REACH = 100

function bestEnd(lines: string[], top: number, bottom: number, size: number): number {
  let best = bottom
  let bestScore: Score | null = null
  const first = Math.max(top, bottom - size - 1, bottom - PLACE_REACH)
  for (let end = first; end <= bottom; end += 1) {
    const score = { level: 0, penalty: 0 }
    edgeAt(lines, end - size, score)
    edgeAt(lines, end, score)
    if (bestScore === null || weigh(score, bestScore) <= 0) {
      best = end
      bestScore = score
    }
  }
  return best
}

// A run of changed lines can move up a line when the line above it equals its
// last line, and down a line when the line below equals its first, and the
// diff is as long either way. As git's output shows, each run, on the old side
// and then on the new, moves as far up and then as far down as it goes,
// merging with any run it meets, until it stops growing. It then ends at the
// lowest place where it sits against a change on the other side, so the two
// print as one change, or, with no such place, where bestEnd puts it.
function settle(side: Side, other: Side): void {
  const { ids, changed, lines } = side
  const n = ids.length
  const kept: number[] = []
  other.changed.forEach((c, j) => {
    if (c === 0) kept.push(j)
  })
  // Whether a run with `above` unchanged lines over it sits against a change
  // on the other side: the other side's lines between the unchanged lines on
  // either side of it are not all kept.
  const meets = (above: number): boolean => {
    const from = above === 0 ? 0 : (kept[above - 1] ?? 0) + 1
    const to = above < kept.length ? (kept[above] ?? 0) : other.changed.length
    return to > from
  }
  let start = 0
  let above = 0
  while (start < n) {
    if (changed[start] === 0) {
      start += 1
      above += 1
      continue
    }
    let end = start
    while (end < n && changed[end] === 1) end += 1
    let size: number
    let top: number
    let meetEnd: number
    do {
      size = end - start
      while (start > 0 && ids[start - 1] === ids[end - 1]) {
        start -= 1
        end -= 1
        changed[start] = 1
        changed[end] = 0
        above -= 1
        while (start > 0 && changed[start - 1] === 1) start -= 1
      }
      top = end
      meetEnd = meets(above) ? end : -1
      while (end < n && ids[start] === ids[end]) {
        changed[start] = 0
        changed[end] = 1
        start += 1
        end += 1
        above += 1
        while (end < n && changed[end] === 1) end += 1
        if (meets(above)) meetEnd = end
      }
    } while (end - start !== size)
    let to = end
    if (meetEnd !== -1) to = meetEnd
    else if (top !== end) to = bestEnd(lines, top, end, size)
    while (end > to) {
      start -= 1
      end -= 1
      changed[start] = 1
      changed[end] = 0
      above -= 1
    }
    start = end
  }
}

// Which lines of `a` and `b` changed, in order: the two files' matching ends
// are kept, the lines set aside are changed, the rest go to the search, and
// every run of changes then settles where git puts it. Past about 500 changed
// lines with few matching lines between them git can stop short of the
// shortest edit and this search does not, and past 8192 edits of the searched
// lines this search gives up and git does not, so the two can differ there;
// no fixture comes near.
function lineOps(a: string[], b: string[]): Op[] {
  const [old, neu] = sidesOf(a, b)
  const shorter = Math.min(a.length, b.length)
  let head = 0
  while (head < shorter && old.ids[head] === neu.ids[head]) head += 1
  let tail = 0
  while (tail < shorter - head && old.ids[a.length - 1 - tail] === neu.ids[b.length - 1 - tail]) {
    tail += 1
  }
  const fromOld = searchedLines(old, countsOf(neu.ids), head, a.length - tail)
  const fromNew = searchedLines(neu, countsOf(old.ids), head, b.length - tail)
  const diagonals = fromOld.length + fromNew.length + 3
  const s: Search = {
    a: Int32Array.from(fromOld, (i) => old.ids[i] ?? -1),
    b: Int32Array.from(fromNew, (j) => neu.ids[j] ?? -1),
    forward: new Int32Array(diagonals),
    reverse: new Int32Array(diagonals),
    offset: fromNew.length + 1,
    goneA: new Uint8Array(fromOld.length),
    goneB: new Uint8Array(fromNew.length),
  }
  searchBox(s, 0, fromOld.length, 0, fromNew.length)
  fromOld.forEach((i, r) => {
    if (s.goneA[r] === 1) old.changed[i] = 1
  })
  fromNew.forEach((j, r) => {
    if (s.goneB[r] === 1) neu.changed[j] = 1
  })
  settle(old, neu)
  settle(neu, old)
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && old.changed[i] === 1) out.push({ kind: '-', text: a[i++] ?? '' })
    else if (j < b.length && neu.changed[j] === 1) out.push({ kind: '+', text: b[j++] ?? '' })
    else {
      out.push({ kind: ' ', text: a[i] ?? '' })
      i += 1
      j += 1
    }
  }
  return out
}

// git's default funcname: the nearest line above the hunk, in the old file,
// that starts with a letter, `_` or `$`, cut to 80 bytes and stripped of
// trailing whitespace. A hunk that finds none keeps the one before it.
function funcLine(line: string): string | null {
  if (!/^[A-Za-z_$]/.test(line)) return null
  return line.slice(0, FUNC_LINE_BYTES).replace(/[ \t\n\v\f\r]+$/, '')
}

function hunkRange(start: number, count: number): string {
  const shown = count === 0 ? start : start + 1
  return count === 1 ? String(shown) : `${String(shown)},${String(count)}`
}

// The hunks of one file: changes closer than twice the context apart share a
// hunk, as git joins them, and each line that ends without a newline is
// followed by git's marker for it.
function hunksOf(ops: Op[], before: string[]): string[] {
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]))
  const first = changed[0]
  if (first === undefined) return []
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = 0
  let n = 0
  for (const op of ops) {
    oldAt.push(o)
    newAt.push(n)
    if (op.kind !== '+') o += 1
    if (op.kind !== '-') n += 1
  }
  const groups: Array<[number, number]> = []
  let start = first
  let end = first + 1
  for (const i of changed.slice(1)) {
    if (i - end <= 2 * CONTEXT) {
      end = i + 1
      continue
    }
    groups.push([start, end])
    start = i
    end = i + 1
  }
  groups.push([start, end])
  let func = ''
  let searched = -1
  return groups.map(([s, e]) => {
    const from = Math.max(0, s - CONTEXT)
    const to = Math.min(ops.length, e + CONTEXT)
    const slice = ops.slice(from, to)
    const oldStart = oldAt[from] ?? 0
    const newStart = newAt[from] ?? 0
    for (let l = oldStart - 1; l > searched && l >= 0; l -= 1) {
      const found = funcLine(before[l] ?? '')
      if (found !== null) {
        func = found
        break
      }
    }
    searched = oldStart - 1
    const oldCount = slice.filter((op) => op.kind !== '+').length
    const newCount = slice.filter((op) => op.kind !== '-').length
    const header = `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`
    const body = slice
      .map((op) => {
        const line = `${op.kind}${op.text}`
        return line.endsWith('\n') ? line : `${line}\n\\ No newline at end of file\n`
      })
      .join('')
    return `${header}${func === '' ? '' : ` ${func}`}\n${body}`
  })
}

function change(
  filename: string,
  previous: string | null,
  status: ChangeStatus,
  was: Buffer | undefined,
  now: Buffer | undefined,
): FileChange {
  const old = was ?? Buffer.alloc(0)
  const neu = now ?? Buffer.alloc(0)
  const binary = isBinary(old) || isBinary(neu)
  const before = linesOf(old)
  const ops = binary || status === 'renamed' ? [] : lineOps(before, linesOf(neu))
  return {
    filename,
    previous,
    status,
    before: was === undefined ? '' : blobSha(was),
    after: now === undefined ? '' : blobSha(now),
    binary,
    additions: ops.filter((op) => op.kind === '+').length,
    deletions: ops.filter((op) => op.kind === '-').length,
    hunks: hunksOf(ops, before),
  }
}

/**
 * Every path that differs between two trees, in path order. A removed path
 * whose exact bytes reappear under a path that was added is one rename, which
 * is the part of git's rename detection a byte comparison can answer. As in
 * git's exact pass, each added path takes the first unused removed path with
 * the same bytes, preferring one with the same file name.
 */
export function diffTrees(before: Tree, after: Tree): FileChange[] {
  const out: FileChange[] = []
  const removed = [...before.keys()].filter((p) => !after.has(p)).sort()
  const renamedFrom = new Set<string>()
  for (const path of [...after.keys()].sort()) {
    const now = after.get(path)
    const was = before.get(path)
    if (was !== undefined) {
      if (now !== undefined && !was.equals(now)) {
        out.push(change(path, null, 'modified', was, now))
      }
      continue
    }
    const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
    const same = removed.filter(
      (old) => !renamedFrom.has(old) && now !== undefined && before.get(old)?.equals(now),
    )
    const source = same.find((old) => name(old) === name(path)) ?? same[0]
    if (source !== undefined) {
      renamedFrom.add(source)
      out.push(change(path, source, 'renamed', before.get(source), now))
    } else {
      out.push(change(path, null, 'added', undefined, now))
    }
  }
  for (const path of removed) {
    if (!renamedFrom.has(path)) out.push(change(path, null, 'removed', before.get(path), undefined))
  }
  return out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
}

const C_ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
}

// A path as git prints it in a diff: bare unless it holds a quote, a
// backslash, a control character or a byte past ASCII, and then C-quoted with
// each such byte in octal, the way `core.quotePath` leaves it by default.
function quoted(path: string): string {
  const bytes = Buffer.from(path)
  if (!bytes.some((b) => b < 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c)) return path
  let out = ''
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte)
    const escape = C_ESCAPES[ch]
    if (escape !== undefined) out += escape
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`
    else out += ch
  }
  return `"${out}"`
}

function short(sha: string): string {
  return sha === '' ? NO_BLOB : sha.slice(0, ABBREV)
}

// One file's section of `git diff`, headers and all, the body GitHub serves as
// `application/vnd.github.diff`.
function fileDiff(c: FileChange): string {
  const was = c.previous ?? c.filename
  const lines = [`diff --git ${quoted(`a/${was}`)} ${quoted(`b/${c.filename}`)}`]
  if (c.status === 'renamed') {
    lines.push(
      'similarity index 100%',
      `rename from ${quoted(was)}`,
      `rename to ${quoted(c.filename)}`,
    )
    return `${lines.join('\n')}\n`
  }
  if (c.status === 'added')
    lines.push('new file mode 100644', `index ${NO_BLOB}..${short(c.after)}`)
  else if (c.status === 'removed')
    lines.push('deleted file mode 100644', `index ${short(c.before)}..${NO_BLOB}`)
  else lines.push(`index ${short(c.before)}..${short(c.after)} 100644`)
  // git follows a name holding a space with a tab on these two lines, so a
  // patch tool can tell where the name ends.
  const tab = (name: string): string => (name.includes(' ') ? `${name}\t` : name)
  const from = c.status === 'added' ? '/dev/null' : tab(quoted(`a/${was}`))
  const to = c.status === 'removed' ? '/dev/null' : tab(quoted(`b/${c.filename}`))
  if (c.binary) {
    const plain = (side: string, name: string): string =>
      side === '/dev/null' ? side : quoted(name)
    lines.push(`Binary files ${plain(from, `a/${was}`)} and ${plain(to, `b/${c.filename}`)} differ`)
  } else if (c.hunks.length > 0) lines.push(`--- ${from}`, `+++ ${to}`)
  return `${lines.join('\n')}\n${c.hunks.join('')}`
}

/** The whole `git diff` of a set of changes, byte for byte. */
export function unifiedDiff(changes: FileChange[]): Buffer {
  return Buffer.from(changes.map(fileDiff).join(''), 'latin1')
}

/**
 * What GitHub's `patch` field holds: the hunks, without the last newline, as
 * text, since a JSON string can carry nothing else.
 */
function patchOf(c: FileChange): string | null {
  if (c.binary || c.hunks.length === 0) return null
  return Buffer.from(c.hunks.join('').replace(/\n$/, ''), 'latin1').toString('utf8')
}

/**
 * One line of a file's patch as a review comment addresses it: by its
 * `position`, counted from the first hunk header, which is 0, or by its line
 * number on the side that holds it. `header` is the position of the hunk
 * header above it.
 */
export interface PatchLine {
  text: string
  position: number
  kind: string
  old: number | null
  new: number | null
  header: number
}

export function patchLines(c: FileChange): PatchLine[] {
  const patch = patchOf(c)
  if (patch === null) return []
  const out: PatchLine[] = []
  let old = 0
  let neu = 0
  let header = 0
  for (const [position, text] of patch.split('\n').entries()) {
    const kind = text.charAt(0)
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (range !== null) {
      old = Number(range[1])
      neu = Number(range[2])
      header = position
      out.push({ text, position, kind, old: null, new: null, header })
      continue
    }
    const onOld = kind === ' ' || kind === '-'
    const onNew = kind === ' ' || kind === '+'
    out.push({ text, position, kind, old: onOld ? old : null, new: onNew ? neu : null, header })
    if (onOld) old += 1
    if (onNew) neu += 1
  }
  return out
}

function urlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * One changed file as the REST API lists it for a pull request, a comparison
 * or a commit. `before` and `after` are the commits either side of the
 * change: a removed file links to the side that still has it, as GitHub's
 * does, and every other file to the side that has it now.
 */
export function changeJson(
  fullName: string,
  c: FileChange,
  before: string,
  after: string,
): JsonValue {
  const ref = c.status === 'removed' ? before : after
  const path = urlPath(c.filename)
  const patch = patchOf(c)
  return {
    sha: c.status === 'removed' ? c.before : c.after,
    filename: c.filename,
    status: c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.additions + c.deletions,
    blob_url: `https://github.com/${fullName}/blob/${ref}/${path}`,
    raw_url: `https://github.com/${fullName}/raw/${ref}/${path}`,
    contents_url: `https://api.github.com/repos/${fullName}/contents/${path}?ref=${ref}`,
    ...(patch === null ? {} : { patch }),
    ...(c.previous === null ? {} : { previous_filename: c.previous }),
  }
}

/** GraphQL's `PatchStatus` spelling of a change. */
export function changeType(c: FileChange): string {
  return { added: 'ADDED', removed: 'DELETED', modified: 'MODIFIED', renamed: 'RENAMED' }[c.status]
}
