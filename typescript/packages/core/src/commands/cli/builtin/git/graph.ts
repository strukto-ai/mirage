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

import type { CommitFacts } from './format.ts'

export const SKIPPED = '...'
// The cell a `--boundary` commit is drawn with, in place of `*`.
export const BOUNDARY = 'o'
// The roots a run climbs through before it starts again in its own column.
const CLIMB = 4

/**
 * One line of the graph: the edge from a printed commit to the commit it
 * leads to. `at` is the cell it is drawn in, two per column, so an odd cell
 * lies between two columns; `goal` the cell of the column it settles in;
 * `heading` -1 while it moves left, 1 while it moves right, 0 at rest.
 * Mirrors _Line in graph.py.
 */
interface Line {
  readonly sha: string
  at: number
  goal: number
  heading: number
}

/**
 * How a commit's parents reach the graph's columns: the ones that open a
 * column, the first in the commit's own; a first parent already waiting to
 * the left, whose line leaves straight for it; every parent but that one,
 * which a merge's fan and an octopus's dashes count; whether the last parent
 * is the one the column right of the commit waits for; and whether the second
 * parent waits in the column left of the commit and leaves with the first.
 * Mirrors _Parents in graph.py.
 */
interface Parents {
  readonly opened: readonly string[]
  readonly lead: string | null
  readonly drawn: readonly string[]
  readonly reach: boolean
  readonly beside: boolean
}

/**
 * Where a commit lands in the graph: its column; the columns there are before
 * it; how its parents reach them; the columns after it, before lines leading
 * to the same commit join; the parents an octopus draws past a merge's two;
 * whether it is an octopus with lines to its right, which it moves right
 * before its own row; the width of its rows; whether no parent of it is in
 * the walk, under `--first-parent` too, and no merge drew it as a later
 * parent; whether it is a root climbing the run of roots before it; the blank
 * cells a root is drawn right of its column by, so the commit drawn next is
 * not taken for its parent; and whether the line leading to it bends right on
 * a row of its own first. Mirrors _Shape in graph.py.
 */
interface Shape {
  readonly col: number
  readonly columns: number
  readonly parents: Parents
  readonly after: readonly string[]
  readonly extra: number
  readonly spreads: boolean
  readonly width: number
  readonly root: boolean
  readonly stairs: boolean
  readonly shift: number
  readonly bends: boolean
}

function line(sha: string, at: number, goal: number): Line {
  return { sha, at, goal, heading: 0 }
}

/**
 * The `--graph` column to the left of a log, one commit at a time. Every
 * walked commit moves the graph on; a commit the log does not print draws
 * nothing, and the next printed one is preceded by a `...` row. Lines move
 * one cell per row, skipping a column another line stands in, and slide under
 * a run of standing columns with `_`; a printed commit owes the rows its
 * lines need to settle. A `--boundary` commit is drawn with `o`; a line leads
 * on from it only to a parent the graph draws too. A path-limited walk hands
 * over the parents it drew its history with.
 *
 * A root, a commit none of whose parents is in the walk and that no merge drew
 * as a later parent, stands a column right of its own when the commit walked
 * next has no line leading to it, unless that one is a root too with more
 * walked after it. Each root after a root, but the last commit walked, climbs
 * a column further right, back to its own column every fourth; one a line
 * leads to joins a run already climbing. A line leading to a root a column
 * right bends on a row of its own, which is the separator a format puts before
 * the commit, or none after a `...` row. Pinned against git 2.56.0. `order`
 * is every commit the graph is walked through, in order. Mirrors CommitGraph
 * in graph.py.
 */
export class CommitGraph {
  private lines: Line[] = []
  private pending: CommitFacts | null = null
  private walked = 0
  private skipped = false
  private resumed = false
  private afterRoot = false
  private stairs = 0
  private readonly fanned = new Set<string>()
  private owed: string[] = []
  private ahead: string[] = []
  private width = 0
  private mergedAt: number | null = null

  constructor(
    private readonly interesting: (oid: string) => boolean,
    private readonly firstParent: boolean,
    private readonly order: readonly CommitFacts[],
    private readonly boundary: ReadonlySet<string> = new Set(),
    private readonly parents: ReadonlyMap<string, readonly string[]> | null = null,
  ) {}

  /** Move on to the next walked commit, printed or not. */
  walk(commit: CommitFacts): void {
    if (this.pending !== null) {
      const rows = this.place(this.pending)
      while (rows.next().done !== true) {
        // each row is drawn and dropped
      }
      this.owed = []
      this.skipped = true
    }
    this.pending = commit
    this.walked += 1
  }

  /**
   * The rows before the walked commit's own, each with its newline, then the
   * cells of its own row, to be followed by its first line; once the commit is
   * drawn, the cells in front of a further header.
   */
  leadIn(): string {
    const commit = this.pending
    if (commit === null) return this.rest(this.width)
    this.pending = null
    const out = this.skipped ? this.skipRow(commit) + '\n' : ''
    const rows = this.ahead.length > 0 ? this.ahead : [...this.place(commit)]
    this.ahead = []
    const star = rows.findIndex((row) => row.includes('*') || row.includes(BOUNDARY))
    this.owed = rows.slice(star + 1)
    return (
      out +
      rows
        .slice(0, star)
        .map((row) => row + '\n')
        .join('') +
      (rows[star] ?? '')
    )
  }

  /** The cells in front of the commit's next line of text. */
  nextRow(): string {
    return this.owed.shift() ?? this.rest(this.width)
  }

  /**
   * The cells in front of a line once the commit's rows are out. Before a
   * walked commit yet to be drawn it is the `...` row when commits were
   * skipped, the commit's first row when it spreads the lines to its right or
   * bends the line leading to it, and otherwise a row as wide as the commit's
   * where the lines stop. Before a commit leaving with a lead and two or more
   * parents besides, the lines right of it stand a cell over, and the row
   * widens by the octopus's dashes and a cell.
   */
  filler(): string {
    const commit = this.pending
    if (commit === null) return this.rest(this.width)
    if (this.skipped) return this.skipRow(commit)
    const shape = this.shape(commit)
    if (shape.spreads || shape.bends) {
      this.ahead = [...this.place(commit)]
      return this.ahead.shift() ?? ''
    }
    const { parents } = shape
    if (parents.lead === null || parents.drawn.length < 2) return this.rest(shape.width, true)
    const width = Math.max(shape.width, 2 * (shape.columns + shape.extra) + 1)
    return this.rest(width, true, 2 * shape.col)
  }

  /**
   * The commit's text with the graph in front of each further line, then the
   * rows the commit still owes; when the text ends with a newline the owed
   * rows end with one too.
   */
  around(text: string): string {
    const lines = text.split('\n')
    let out = lines[0] ?? ''
    for (const piece of lines.slice(1, -1)) out += '\n' + this.nextRow() + piece
    if (lines.length > 1) {
      const tail = lines[lines.length - 1] ?? ''
      out += tail === '' ? '\n' : '\n' + this.nextRow()
      out += tail
    }
    const owed = this.owed
    this.owed = []
    if (text.endsWith('\n')) return out + owed.map((row) => row + '\n').join('')
    return out + owed.map((row) => '\n' + row).join('')
  }

  private skipRow(commit: CommitFacts): string {
    const width = this.shape(commit).width
    this.rest(width, true)
    this.skipped = false
    this.resumed = true
    return SKIPPED.padEnd(Math.max(SKIPPED.length, width))
  }

  private columns(): string[] {
    const order = [...this.lines].sort((a, b) => a.goal - b.goal)
    return [...new Set(order.map((each) => each.sha))]
  }

  private ownParents(commit: CommitFacts): readonly string[] {
    return this.parents?.get(commit.oid) ?? commit.parents
  }

  private isRoot(commit: CommitFacts): boolean {
    return !this.fanned.has(commit.oid) && !this.ownParents(commit).some((p) => this.interesting(p))
  }

  private followed(commit: CommitFacts): string[] {
    const own = this.ownParents(commit)
    const followed = this.firstParent ? own.slice(0, 1) : own
    return [...new Set(followed.filter((p) => this.interesting(p)))]
  }

  private parentsOf(commit: CommitFacts, columns: string[], col: number): Parents {
    const parents = this.followed(commit)
    const where = new Map(columns.map((sha, i) => [sha, i]))
    const opened: string[] = []
    let lead: string | null = null
    let reach = false
    let beside = false
    const last = parents.length - 1
    parents.forEach((parent, i) => {
      const j = where.get(parent)
      if (j !== undefined && i === 0 && j < col) lead = parent
      else if (j !== undefined && i === 1 && lead !== null && j === col - 1 && parents.length >= 3)
        beside = true
      else if (
        j !== undefined &&
        i === last &&
        opened.length > 0 &&
        j === col + 1 &&
        where.has(commit.oid)
      )
        reach = true
      else opened.push(parent)
    })
    const drawn = parents.filter((p) => p !== lead)
    return { opened, lead, drawn, reach, beside }
  }

  private shape(commit: CommitFacts): Shape {
    const columns = this.columns()
    const known = columns.includes(commit.oid)
    const col = known ? columns.indexOf(commit.oid) : columns.length
    const parents = this.parentsOf(commit, columns, col)
    const after = [...columns.slice(0, col), ...parents.opened, ...columns.slice(col + 1)]
    const extra = Math.max(parents.drawn.length - 2, 0)
    const spreads =
      extra > 0 && this.lines.some((each) => each.sha !== commit.oid && each.goal > 2 * col)
    // Spreading moves the rightmost line two cells per extra parent, past the
    // columns its parents take when some reach or leave with the lead.
    const width =
      2 *
      Math.max(columns.length + (known ? 0 : 1), after.length, spreads ? columns.length + extra : 0)
    const root = this.isRoot(commit)
    const upcoming = this.order.slice(this.walked, this.walked + 2)
    const stairs = root && this.afterRoot && upcoming.length > 0 && (!known || this.stairs > 0)
    const climb = stairs ? (this.stairs + 1) % CLIMB : 0
    const follows = upcoming[0]
    const lifted =
      root &&
      follows !== undefined &&
      !columns.includes(follows.oid) &&
      !(upcoming.length > 1 && this.isRoot(follows))
    const shift = 2 * Math.max(climb, lifted ? 1 : 0)
    return {
      col,
      columns: columns.length,
      parents,
      after,
      extra,
      spreads,
      width,
      root,
      stairs,
      shift,
      bends: known && climb === 0 && lifted,
    }
  }

  /**
   * Move the lines through a commit's rows, each row yielded as it is drawn,
   * so that a commit the log skips holds none of them.
   */
  private *place(commit: CommitFacts): Generator<string, void, undefined> {
    const shape = this.shape(commit)
    const { parents, width, extra } = shape
    const here = 2 * shape.col
    const resumed = this.resumed
    this.resumed = false
    if (shape.bends && !resumed) {
      const row = this.rest(width + 1, true, here - 1)
      yield row.slice(0, here + 1) + '\\' + row.slice(here + 2)
    }
    const final = [...new Set(shape.after)]
    const goalOf = new Map(final.map((sha, i) => [sha, 2 * i]))
    const goal = (sha: string): number => goalOf.get(sha) ?? 0
    this.width = width + shape.shift
    this.stairs = shape.stairs ? this.stairs + 1 : 0
    this.afterRoot = shape.root
    for (const parent of this.followed(commit).slice(1)) this.fanned.add(parent)
    const opened = parents.opened.length
    const spread = 2 * Math.max(opened - 1, 0)
    const others = this.lines.filter((each) => each.sha !== commit.oid)
    const right = new Set(others.filter((each) => each.goal > here))
    const base = new Map<Line, number>()
    for (const each of right) base.set(each, each.at + (each.at % 2 ? each.heading : 0))
    const lift = shape.spreads ? 2 * extra : 0
    if (lift) yield* this.spreadRows(others, right, base, here, width, lift)
    const drawn = this.commitRow(others, right, base, here, width, lift, spread, goal, extra)
    const row = this.boundary.has(commit.oid)
      ? drawn.slice(0, here) + BOUNDARY + drawn.slice(here + 1)
      : drawn
    yield row.slice(0, here) + ' '.repeat(shape.shift) + row.slice(here)
    const born = parents.opened.map((sha) => line(sha, here, goal(sha)))
    const led = parents.lead === null ? [] : [line(parents.lead, here, goal(parents.lead))]
    for (const each of others) each.goal = goal(each.sha)
    const merging = parents.drawn.length + (parents.lead === null ? 0 : 1) >= 2
    if (merging) yield this.mergeRow(others, right, base, born, led, here, width, spread, parents)
    // A reach's edge takes the fan's next cell after the opened parents. That
    // is the spread column's own cell unless a beside parent left the fan a
    // cell short, and then the edge stays a line of its own.
    const reached: Line[] = []
    const reach = parents.drawn[parents.drawn.length - 1]
    if (parents.reach && parents.beside && lift && reach !== undefined)
      reached.push(line(reach, here + 2 * opened, goal(reach)))
    this.lines = [...others, ...born, ...led, ...reached]
    this.join()
    this.mergedAt = merging && this.settled() ? here : null
    while (!this.settled()) yield this.collapseRow(this.width)
  }

  private *spreadRows(
    others: Line[],
    right: Set<Line>,
    base: Map<Line, number>,
    here: number,
    width: number,
    lift: number,
  ): Generator<string, void, undefined> {
    for (let step = 0; step < lift; step++) {
      const cells = new Array<string>(width).fill(' ')
      cells[here] = '|'
      for (const each of others) {
        if (right.has(each)) {
          const moving =
            step > 0 || each.heading > 0 || (this.mergedAt !== null && each.at > this.mergedAt)
          each.at = (base.get(each) ?? each.at) + step
          cells[each.at] = moving ? '\\' : '|'
        } else {
          if (each.at % 2) each.at += each.heading
          each.heading = 0
          cells[each.at] = '|'
        }
      }
      yield cells.join('')
    }
  }

  private commitRow(
    others: Line[],
    right: Set<Line>,
    base: Map<Line, number>,
    here: number,
    width: number,
    lift: number,
    spread: number,
    goal: (sha: string) => number,
    extra: number,
  ): string {
    const cells = new Array<string>(width).fill(' ')
    const merging = spread > 0
    for (const each of others) {
      const target = goal(each.sha)
      const onRight = right.has(each)
      let glyph: string
      if (onRight && lift) {
        each.at = (base.get(each) ?? each.at) + lift
        const moving = lift < spread
        glyph = moving ? '\\' : '|'
        each.heading = moving ? 1 : 0
      } else if (each.at % 2 || each.heading) {
        if (each.at % 2) each.at += each.heading
        if (each.heading < 0 && target < each.at && !(onRight && merging)) glyph = '/'
        else if (each.heading > 0 && onRight && merging) glyph = '\\'
        else {
          glyph = '|'
          each.heading = 0
        }
      } else {
        glyph = '|'
        each.heading = 0
      }
      cells[each.at] = glyph
    }
    cells[here] = '*'
    if (extra) {
      for (let i = 0; i < 2 * extra - 1; i++) cells[here + 1 + i] = '-'
      cells[here + 2 * extra] = '.'
    }
    return cells.join('')
  }

  private mergeRow(
    others: Line[],
    right: Set<Line>,
    base: Map<Line, number>,
    born: Line[],
    led: Line[],
    here: number,
    width: number,
    spread: number,
    parents: Parents,
  ): string {
    const cells = new Array<string>(width).fill(' ')
    for (const each of others) {
      if (right.has(each) && each.at < (base.get(each) ?? each.at) + spread) {
        each.at += 1
        each.heading = 1
        cells[each.at] = '\\'
      } else cells[each.at] = '|'
    }
    if (born.length) cells[here] = '|'
    for (let k = 1; k < parents.drawn.length; k++) cells[here + 2 * k - 1] = '\\'
    const settle = parents.reach && parents.drawn.length > 2
    born.slice(1).forEach((each, index) => {
      const i = index + 1
      if (settle) {
        each.at = here + 2 * i
        return
      }
      each.at = here + 2 * i - 1
      each.heading = 1
    })
    if (parents.beside) cells[here - 1] = '/'
    const standing = new Set(
      [...others, ...born]
        .filter((each) => each.at === each.goal && each.heading === 0)
        .map((each) => each.at),
    )
    for (const each of led) {
      for (const [cell, glyph] of this.step(each, standing, true)) cells[cell] = glyph
      if (each.at === each.goal + 1) {
        each.at = each.goal
        each.heading = 0
      }
    }
    return cells.join('')
  }

  private settled(): boolean {
    return this.lines.every(
      (each) =>
        each.at === each.goal ||
        (each.at === each.goal + 1 && each.heading < 0) ||
        (each.at === each.goal - 1 && each.heading > 0),
    )
  }

  /**
   * Move a line one row toward its column: the cells it draws and their
   * glyphs. `standing` holds the cells of columns whose lines stand still this
   * row, which a moving line passes under; `glide` whether it may slide under
   * a run of them; `taken` the cells lines start a collapsing row in.
   */
  private step(
    each: Line,
    standing: Set<number>,
    glide: boolean,
    taken: ReadonlySet<number> = new Set(),
  ): [number, string][] {
    if (each.at === each.goal) {
      each.heading = 0
      return [[each.at, '|']]
    }
    if (each.heading > 0 && each.goal > each.at) {
      each.at += 1
      if (each.at === each.goal) {
        each.heading = 0
        return [[each.at, '|']]
      }
      return [[each.at, '\\']]
    }
    if (each.heading > 0) each.at += 1
    each.heading = -1
    let marks: [number, string][]
    if (each.at % 2) {
      each.at -= 1
      if (each.at !== each.goal && standing.has(each.at)) each.at -= 1
      if (each.at === each.goal) {
        each.heading = 0
        return [[each.at, '|']]
      }
      marks = [[each.at, '/']]
      if (each.at % 2 === 0) {
        // Landing beside a column whose line already stands there, with the
        // cell past it free, the line slides under it on the same row.
        const under = each.at - 2
        if (
          !(
            glide &&
            taken.has(under) &&
            !taken.has(under - 1) &&
            standing.has(under) &&
            under > each.goal + 2
          )
        )
          return marks
        each.at = under - 1
        marks.push([each.at, '_'])
      }
    } else {
      each.at -= 1
      marks = [[each.at, '/']]
    }
    while (glide && standing.has(each.at - 1) && each.at - 1 > each.goal + 2) {
      each.at -= 2
      marks.push([each.at, '_'])
    }
    return marks
  }

  private collapseRow(width: number): string {
    const cells = new Array<string>(width).fill(' ')
    const standing = new Set(
      this.lines
        .filter(
          (each) =>
            each.at === each.goal || (each.at % 2 !== 0 && each.at + each.heading === each.goal),
        )
        .map((each) => each.goal),
    )
    const busy = this.lines
      .filter((each) => each.at % 2 !== 0 && each.heading < 0 && each.at - 1 !== each.goal)
      .map((each) => each.at)
    const taken = new Set(this.lines.map((each) => each.at))
    for (const each of [...this.lines].sort((a, b) => a.at - b.at)) {
      const glide = !busy.some((at) => at < each.at)
      for (const [cell, glyph] of this.step(each, standing, glide, taken))
        if (cells[cell] === ' ' || glyph !== '|') cells[cell] = glyph
    }
    this.join()
    return cells.join('')
  }

  private join(): void {
    const kept: Line[] = []
    const seen = new Set<string>()
    const ordered = [...this.lines].sort(
      (a, b) => a.at - b.at || Number(a.heading !== 0) - Number(b.heading !== 0),
    )
    for (const each of ordered) {
      const key = `${each.sha} ${String(each.at)}`
      if (each.at === each.goal && seen.has(key)) continue
      if (each.at === each.goal) seen.add(key)
      kept.push(each)
    }
    this.lines = kept
  }

  /**
   * A row of every line in its column; with `settle` the lines stop too,
   * otherwise a line still on its way keeps going on the next commit's row;
   * with `past` the lines right of that cell are drawn a cell further right.
   */
  private rest(width: number, settle = false, past: number | null = null): string {
    this.mergedAt = null
    const cells = new Array<string>(width).fill(' ')
    for (const each of this.lines) {
      if (each.at % 2) each.at += each.heading
      if (settle) each.heading = 0
      cells[each.at + (past !== null && each.at > past ? 1 : 0)] = '|'
    }
    return cells.join('')
  }
}
