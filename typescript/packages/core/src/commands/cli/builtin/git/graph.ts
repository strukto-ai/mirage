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

// What the next line of output draws. A commit's lines run SKIP (when the one
// before it never finished), PRE_COMMIT (room for an octopus), COMMIT,
// POST_MERGE (a merge's edges), COLLAPSING (branch lines moving left) and
// PADDING, the resting state between commits.
type GraphState = 'padding' | 'skip' | 'preCommit' | 'commit' | 'postMerge' | 'collapsing'

const MERGE_CHARS = ['/', '|', '\\']

/**
 * The `--graph` column drawer: git's graph.c, one commit at a time.
 *
 * Each column holds the commit its branch line leads to. A commit takes its
 * own column (or a new one at the right), its interesting parents take its
 * place in the next row's columns, and `mapping` says where each edge of the
 * current row lands in the next, two screen cells per column. Lines are drawn
 * until every edge has collapsed into its column, which is when the commit is
 * finished and the next one may start. Pinned line for line against git 2.50.1
 * on generated histories, trailing spaces included: every line is padded to
 * the row's width so text after the graph stays aligned.
 */
export class CommitGraph {
  private readonly interesting: (oid: string) => boolean
  private readonly firstParentOnly: boolean
  private commit: CommitFacts | null = null
  private parents: string[] = []
  private state: GraphState = 'padding'
  private prevState: GraphState = 'padding'
  private commitIndex = 0
  private prevCommitIndex = 0
  private mergeLayout = 0
  private edgesAdded = 0
  private prevEdgesAdded = 0
  private width = 0
  private expansionRow = 0
  private columns: string[] = []
  private newColumns: string[] = []
  private mapping: number[] = []
  private oldMapping: number[] = []
  private mappingSize = 0

  /**
   * @param interesting whether a parent is one the walk shows, which is the
   *   only kind of parent a line is drawn to
   * @param firstParentOnly `--first-parent`: a merge draws its first parent
   *   alone
   */
  constructor(interesting: (oid: string) => boolean, firstParentOnly: boolean) {
    this.interesting = interesting
    this.firstParentOnly = firstParentOnly
  }

  /** Start the next commit's lines; the previous commit's are abandoned. */
  update(commit: CommitFacts): void {
    this.commit = commit
    const first = commit.parents[0]
    if (this.firstParentOnly) {
      this.parents = first !== undefined && this.interesting(first) ? [first] : []
    } else {
      this.parents = commit.parents.filter((parent) => this.interesting(parent))
    }
    this.prevCommitIndex = this.commitIndex
    this.updateColumns()
    this.expansionRow = 0
    // Not updateState: no line of the new state has been drawn, so the one
    // before it stays whatever was drawn last.
    if (this.state !== 'padding') this.state = 'skip'
    else if (this.needsPreCommitLine()) this.state = 'preCommit'
    else this.state = 'commit'
  }

  /** Whether every edge of the current commit has settled. */
  isFinished(): boolean {
    return this.state === 'padding'
  }

  /** The next line and whether it was the commit's own. */
  nextLine(): [string, boolean] {
    let line: string
    let shown = false
    switch (this.state) {
      case 'padding':
        line = this.paddingRow()
        break
      case 'skip':
        line = this.skipLine()
        break
      case 'preCommit':
        line = this.preCommitLine()
        break
      case 'commit':
        line = this.commitLine()
        shown = true
        break
      case 'postMerge':
        line = this.postMergeLine()
        break
      case 'collapsing':
        line = this.collapsingLine()
        break
    }
    return [line.padEnd(this.width), shown]
  }

  /**
   * A line that leaves every branch as it is, for text that runs past the
   * commit's own lines; while the commit line is still due it draws the
   * current columns, else it is simply the next line.
   */
  paddingLine(): string {
    if (this.state !== 'commit') return this.nextLine()[0]
    let line = ''
    for (const column of this.columns) {
      line += '|'
      line +=
        column === this.commit?.oid && this.parents.length > 2
          ? ' '.repeat((this.parents.length - 2) * 2)
          : ' '
    }
    this.prevState = 'padding'
    return line.padEnd(this.width)
  }

  /** Every line up to and including the commit's own, which ends unterminated. */
  showCommit(): string {
    if (this.isFinished()) return this.paddingLine()
    let out = ''
    let shown = false
    while (!shown && !this.isFinished()) {
      const [line, commit] = this.nextLine()
      out += line
      shown = commit
      if (!shown) out += '\n'
    }
    return out
  }

  /**
   * A commit's text after its first line, each further line behind the next
   * graph line, then whatever lines the commit still owes.
   */
  showMessage(text: string): string {
    const parts = text.split('\n')
    let out = ''
    parts.forEach((part, index) => {
      out += part
      if (index < parts.length - 1) {
        out += '\n'
        if (index < parts.length - 2 || parts[parts.length - 1] !== '') out += this.nextLine()[0]
      }
    })
    if (this.isFinished()) return out
    const terminated = text.endsWith('\n')
    if (!terminated) out += '\n'
    out += this.remainder()
    if (terminated) out += '\n'
    return out
  }

  /** The lines a commit still owes, the last one unterminated. */
  private remainder(): string {
    let out = ''
    while (!this.isFinished()) {
      out += this.nextLine()[0]
      if (!this.isFinished()) out += '\n'
    }
    return out
  }

  private updateState(state: GraphState): void {
    this.prevState = this.state
    this.state = state
  }

  /**
   * The parents an octopus draws dashes to: every one past the first two,
   * one fewer when the merge leans left, since its first parent then takes
   * the column beside it.
   */
  private dashedParents(): number {
    return this.parents.length + this.mergeLayout - 3
  }

  /** Two rows of room for each dashed parent, while there is a column to its right. */
  private needsPreCommitLine(): boolean {
    return (
      this.parents.length >= 3 &&
      this.commitIndex < this.columns.length - 1 &&
      this.expansionRow < this.dashedParents() * 2
    )
  }

  private isMappingCorrect(): boolean {
    for (let i = 0; i < this.mappingSize; i += 1) {
      const target = this.mapping[i] ?? -1
      if (target >= 0 && target !== Math.floor(i / 2)) return false
    }
    return true
  }

  /**
   * The cells one row draws, by column: every column, then this commit's own
   * when it is in none of them.
   */
  private *row(oid: string): Generator<[number, string]> {
    yield* this.columns.entries()
    if (!this.columns.includes(oid)) yield [this.columns.length, oid]
  }

  /**
   * Lay out the next row: the columns after this commit, and where each edge
   * of this row lands in them.
   */
  private updateColumns(): void {
    const oid = this.commit?.oid ?? ''
    this.columns = this.newColumns
    this.newColumns = []
    this.mappingSize = 2 * (this.columns.length + this.parents.length)
    this.mapping = new Array<number>(this.mappingSize).fill(-1)
    this.width = 0
    this.prevEdgesAdded = this.edgesAdded
    this.edgesAdded = 0
    for (const [i, column] of this.row(oid)) {
      if (column === oid) {
        this.commitIndex = i
        this.mergeLayout = -1
        for (const parent of this.parents) this.insertColumn(parent, i)
        // A commit takes two cells even when nothing leaves it.
        if (this.parents.length === 0) this.width += 2
      } else {
        this.insertColumn(column, -1)
      }
    }
    while (this.mappingSize > 1 && (this.mapping[this.mappingSize - 1] ?? -1) < 0) {
      this.mappingSize -= 1
    }
  }

  /**
   * Give a commit a column in the next row, reusing one that already leads
   * there, and record where the edge from this row lands.
   *
   * The first parent of a merge picks the merge's layout: whether its edges
   * start one cell left of the commit (the parent sits to the left) or at it.
   * An edge the merge added that lands on the last column already taken joins
   * it at once rather than running beside it for a row.
   */
  private insertColumn(oid: string, index: number): void {
    let i = this.newColumns.indexOf(oid)
    if (i < 0) {
      i = this.newColumns.length
      this.newColumns.push(oid)
    }
    let at: number
    if (this.parents.length > 1 && index > -1 && this.mergeLayout === -1) {
      const distance = index - i
      const shift = distance > 1 ? 2 * distance - 3 : 1
      this.mergeLayout = distance > 0 ? 0 : 1
      this.edgesAdded = this.parents.length + this.mergeLayout - 2
      at = this.width + (this.mergeLayout - 1) * shift
      this.width += 2 * this.mergeLayout
    } else if (this.edgesAdded > 0 && i === this.mapping[this.width - 2]) {
      at = this.width - 2
      this.edgesAdded = -1
    } else {
      at = this.width
      this.width += 2
    }
    this.mapping[at] = i
  }

  private paddingRow(): string {
    return '| '.repeat(this.newColumns.length)
  }

  private skipLine(): string {
    this.updateState(this.needsPreCommitLine() ? 'preCommit' : 'commit')
    return '...'
  }

  /** One of the rows that widen the space around an octopus merge. */
  private preCommitLine(): string {
    let line = ''
    let seenThis = false
    this.columns.forEach((column, i) => {
      if (column === this.commit?.oid) {
        seenThis = true
        line += `|${' '.repeat(this.expansionRow)}`
      } else if (seenThis && this.expansionRow === 0) {
        line += this.prevState === 'postMerge' && this.prevCommitIndex < i ? '\\' : '|'
      } else if (seenThis && this.expansionRow > 0) {
        line += '\\'
      } else {
        line += '|'
      }
      line += ' '
    })
    this.expansionRow += 1
    if (!this.needsPreCommitLine()) this.updateState('commit')
    return line
  }

  private commitLine(): string {
    const oid = this.commit?.oid ?? ''
    let line = ''
    let seenThis = false
    for (const [i, column] of this.row(oid)) {
      if (column === oid) {
        seenThis = true
        line += '*'
        if (this.parents.length > 2) line += this.octopusDashes()
      } else if (seenThis && this.edgesAdded > 1) {
        line += '\\'
      } else if (seenThis && this.edgesAdded === 1) {
        line +=
          this.prevState === 'postMerge' && this.prevEdgesAdded > 0 && this.prevCommitIndex < i
            ? '\\'
            : '|'
      } else if (
        this.prevState === 'collapsing' &&
        this.oldMapping[2 * i + 1] === i &&
        (this.mapping[2 * i] ?? -1) < i
      ) {
        line += '/'
      } else {
        line += '|'
      }
      line += ' '
    }
    if (this.parents.length > 1) this.updateState('postMerge')
    else if (this.isMappingCorrect()) this.updateState('padding')
    else this.updateState('collapsing')
    return line
  }

  private octopusDashes(): string {
    const dashed = this.dashedParents()
    let out = ''
    for (let i = 0; i < dashed; i += 1) out += i === dashed - 1 ? '-.' : '--'
    return out
  }

  private postMergeLine(): string {
    const oid = this.commit?.oid ?? ''
    const firstParent = this.parents[0]
    let line = ''
    let seenThis = false
    let parentSeen = false
    for (const [i, column] of this.row(oid)) {
      if (column === oid) {
        seenThis = true
        let at = this.mergeLayout
        this.parents.forEach((_, j) => {
          line += MERGE_CHARS[at] ?? ''
          if (at === 2) {
            if (this.edgesAdded > 0 || j < this.parents.length - 1) line += ' '
          } else {
            at += 1
          }
        })
        if (this.edgesAdded === 0) line += ' '
      } else if (seenThis) {
        line += this.edgesAdded > 0 ? '\\ ' : '| '
      } else {
        line += '|'
        if (this.mergeLayout !== 0 || i !== this.commitIndex - 1) line += parentSeen ? '_' : ' '
      }
      if (column === firstParent) parentSeen = true
    }
    this.updateState(this.isMappingCorrect() ? 'padding' : 'collapsing')
    return line
  }

  /**
   * Move every edge not yet in its column one cell left, crossing at most one
   * other edge; a single edge may instead run horizontally (`_`) across the
   * columns between it and its target.
   */
  private collapsingLine(): string {
    let horizontalEdge = -1
    let horizontalTarget = -1
    let usedHorizontal = false
    ;[this.mapping, this.oldMapping] = [this.oldMapping, this.mapping]
    for (let i = 0; i < this.mappingSize; i += 1) this.mapping[i] = -1
    for (let i = 0; i < this.mappingSize; i += 1) {
      const target = this.oldMapping[i] ?? -1
      if (target < 0) continue
      if (target * 2 === i) {
        this.mapping[i] = target
      } else if ((this.mapping[i - 1] ?? -1) < 0) {
        this.mapping[i - 1] = target
        if (horizontalEdge === -1) {
          horizontalEdge = i
          horizontalTarget = target
          for (let j = target * 2 + 3; j < i - 2; j += 2) this.mapping[j] = target
        }
      } else if (this.mapping[i - 1] === target) {
        continue
      } else {
        this.mapping[i - 2] = target
        if (horizontalEdge === -1) {
          horizontalTarget = target
          horizontalEdge = i - 1
          for (let j = target * 2 + 3; j < i - 2; j += 2) this.mapping[j] = target
        }
      }
    }
    this.oldMapping = this.mapping.slice(0, this.mappingSize)
    if ((this.mapping[this.mappingSize - 1] ?? -1) < 0) this.mappingSize -= 1
    let line = ''
    for (let i = 0; i < this.mappingSize; i += 1) {
      const target = this.mapping[i] ?? -1
      if (target < 0) {
        line += ' '
      } else if (target * 2 === i) {
        line += '|'
      } else if (target === horizontalTarget && i !== horizontalEdge - 1) {
        // Only the first segment of a horizontal run carries into the next
        // line; the rest were drawn here and are done.
        if (i !== target * 2 + 3) this.mapping[i] = -1
        usedHorizontal = true
        line += '_'
      } else {
        if (usedHorizontal && i < horizontalEdge) this.mapping[i] = -1
        line += '/'
      }
    }
    if (this.isMappingCorrect()) this.updateState('padding')
    return line
  }
}
