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

import { Errors } from 'isomorphic-git'
import { getOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { plural } from './dates.ts'
import { short } from './format.ts'
import { readBlobBytes, type Repo } from './repo.ts'
import type { TreeEntry } from './tree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { textWidth } from '../../../../utils/width.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'

const ROOT_COMMIT = '(root-commit) '
// A diffstat is 80 columns wide when the output is not a terminal, and a file
// reads as binary when its first 8000 bytes hold a NUL.
const STAT_WIDTH = 80
export const BINARY_SNIFF = 8000
// The narrowest name column and graph a diffstat shrinks to, how a cut name
// starts, and what a binary row puts in the count column.
const NARROWEST_NAME = 10
const NARROWEST_GRAPH = 6
const ELIDED = '...'
const BINARY_COUNT = 'Bin'
// What a row spends besides the name, count and graph: the leading space,
// " | ", the space after the count, and the last column, left free.
const FRAME = 6
const SLASH = 0x2f

const DEC = new TextDecoder('utf-8', { fatal: false })

/** One changed path as the diffstat table renders it. */
export interface FileStat {
  readonly path: string
  /** Lines added, 0 for a binary file. */
  readonly insertions: number
  /** Lines removed, 0 for a binary file. */
  readonly deletions: number
  /** Whether either side sniffs as binary. */
  readonly binary: boolean
  /** Byte length of the old blob, 0 when created. */
  readonly oldSize: number
  /** Byte length of the new blob, 0 when deleted. */
  readonly newSize: number
}

/**
 * A blob's bytes, empty when there is nothing to read.
 *
 * A gitlink names a commit in another repository, so its id is legitimately
 * absent from this store, or names one of its commits rather than a blob; it
 * reads as empty rather than failing the whole table.
 */
async function blobData(repo: Repo, oid: string | null): Promise<Uint8Array> {
  if (oid === null) return new Uint8Array(0)
  try {
    return await readBlobBytes(repo, oid)
  } catch (err) {
    if (err instanceof Errors.NotFoundError || err instanceof Errors.ObjectTypeError)
      return new Uint8Array(0)
    throw err
  }
}

function hasNul(data: Uint8Array): boolean {
  const window = data.subarray(0, BINARY_SNIFF)
  return window.includes(0)
}

/** Line insertions and deletions between two text blobs. */
function countLines(oldData: Uint8Array, newData: Uint8Array): [number, number] {
  const split = (data: Uint8Array): string[] => {
    const text = DEC.decode(data)
    return text === '' ? [] : text.split(/(?<=\n)/)
  }
  let insertions = 0
  let deletions = 0
  for (const [tag, i1, i2, j1, j2] of getOpcodes(split(oldData), split(newData))) {
    if (tag === DiffOpTag.EQUAL) continue
    deletions += i2 - i1
    insertions += j2 - j1
  }
  return [insertions, deletions]
}

/**
 * Per-path change counts between two trees, in path order.
 *
 * A binary file (NUL in the first 8000 bytes of either side, git's own sniff)
 * counts zero lines; a mode-only change counts zero too but still occupies a
 * row, which is how git prints `path | 0`.
 */
export async function diffstat(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): Promise<FileStat[]> {
  const stats: FileStat[] = []
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints)) {
    const old = before.get(path) ?? null
    const now = after.get(path) ?? null
    if (old?.oid === now?.oid && old?.mode === now?.mode) continue
    const oldData = await blobData(repo, old?.oid ?? null)
    const newData = await blobData(repo, now?.oid ?? null)
    const binary = hasNul(oldData) || hasNul(newData)
    let insertions = 0
    let deletions = 0
    if (!binary && old?.oid !== now?.oid) {
      ;[insertions, deletions] = countLines(oldData, newData)
    }
    stats.push({
      path,
      insertions,
      deletions,
      binary,
      oldSize: oldData.byteLength,
      newSize: newData.byteLength,
    })
  }
  return stats
}

/**
 * How many graph columns a scaled count takes: one for anything nonzero and its
 * share of the rest, rounded down (git 2.50.1 gives the largest change the
 * whole graph and 1 of 1000 lines in a 21-wide graph one mark).
 *
 * @param count the lines counted
 * @param graph the graph's width
 * @param largest the largest change in the table
 */
function marks(count: number, graph: number, largest: number): number {
  return count ? 1 + Math.floor((count * (graph - 1)) / largest) : 0
}

/**
 * A path cut to the name column from the left: `...` and the tail from the
 * next `/` on. The cut drops as many bytes as the path is columns too wide,
 * which is why git 2.50.1 leaves a path of wide characters wider than the
 * column.
 *
 * @param path the path as the table shows it
 * @param column the name column's width
 */
function fittedName(path: string, column: number): string {
  const shown = textWidth(path)
  if (shown <= column) return path
  const over = shown - (column - ELIDED.length)
  let tail = encodeText(path).subarray(Math.max(over, 0))
  const slash = tail.indexOf(SLASH)
  if (slash >= 0) tail = tail.subarray(slash)
  return ELIDED + decodeText(tail)
}

/**
 * git's diffstat table: one row per path, then the summary line.
 *
 * A row is ` <name> | <count> <graph>`, at most `width - 1` columns, and never
 * narrower than a 10-column name and a 6-column graph allow. The count column
 * fits the largest change, and `Bin` when a binary row reads
 * `Bin <old> -> <new> bytes`, whose text after `Bin` claims graph room too.
 * When the names and the graph do not both fit, a graph needing no more than
 * its share (three eighths of the width, less the count column and six) keeps
 * what it needs and the names take the rest; a wider one gets that share, at
 * least 6 columns, or more if the names are short, and is scaled into it: the
 * total, and then the smaller side (deletions on a tie), take their marks and
 * the larger side keeps the rest, with two marks at least when both are
 * nonzero. Measured against git 2.50.1 and 2.47.3 over 400 tables at 24 widths
 * each.
 *
 * @param stats per-path counts from `diffstat`
 * @param width total line budget, git's `--stat-width`
 */
export function statTable(stats: readonly FileStat[], width: number = STAT_WIDTH): string[] {
  if (stats.length === 0) return []
  const largest = Math.max(
    0,
    ...stats.filter((s) => !s.binary).map((s) => s.insertions + s.deletions),
  )
  const sizes = stats
    .filter((s) => s.binary)
    .map((s) => `${String(s.oldSize)} -> ${String(s.newSize)} bytes`)
  const countColumn = Math.max(String(largest).length, sizes.length > 0 ? BINARY_COUNT.length : 0)
  const wanted = Math.max(largest, ...sizes.map((size) => size.length))
  const widest = Math.max(...stats.map((s) => textWidth(s.path)))
  const total = Math.max(width, NARROWEST_NAME + NARROWEST_GRAPH + countColumn + FRAME)
  const room = total - FRAME - countColumn
  const share = Math.floor((total * 3) / 8) - FRAME - countColumn
  let graph: number
  let column: number
  if (widest + wanted <= room) [graph, column] = [wanted, widest]
  else if (wanted <= share) [graph, column] = [wanted, room - wanted]
  else {
    const given = Math.max(NARROWEST_GRAPH, share, room - widest)
    ;[graph, column] = [Math.min(wanted, given), Math.min(widest, room - given)]
  }
  const rows = stats.map((stat) => {
    const name = fittedName(stat.path, column)
    const cell = ` ${name}${' '.repeat(Math.max(0, column - textWidth(name)))} | `
    if (stat.binary)
      return `${cell}${BINARY_COUNT.padStart(countColumn)} ${String(stat.oldSize)} -> ${String(stat.newSize)} bytes`
    let plus = stat.insertions
    let minus = stat.deletions
    if (largest > graph) {
      const whole = Math.max(marks(plus + minus, graph, largest), plus && minus ? 2 : 0)
      if (plus < minus) {
        plus = marks(plus, graph, largest)
        minus = whole - plus
      } else {
        minus = marks(minus, graph, largest)
        plus = whole - minus
      }
    }
    const bar = '+'.repeat(plus) + '-'.repeat(minus)
    const count = String(stat.insertions + stat.deletions).padStart(countColumn)
    return `${cell}${count}${bar ? ` ${bar}` : ''}`
  })
  const insertions = stats.reduce((sum, s) => sum + s.insertions, 0)
  const deletions = stats.reduce((sum, s) => sum + s.deletions, 0)
  return [...rows, statLine(stats.length, insertions, deletions)]
}

/**
 * git's one-line diffstat.
 *
 * A clause that would read zero is dropped, unless both would, in which case
 * both are kept: a commit that changed a file without changing a line still has
 * to say something about the lines, and " 1 file changed" alone reads like a
 * truncation. Pinned against git 2.47 by committing an empty file.
 */
function statLine(files: number, insertions: number, deletions: number): string {
  const parts = [` ${plural(files, 'file')} changed`]
  if (insertions !== 0 || deletions === 0) parts.push(`${plural(insertions, 'insertion')}(+)`)
  if (deletions !== 0 || insertions === 0) parts.push(`${plural(deletions, 'deletion')}(-)`)
  return parts.join(', ')
}

/**
 * What `git commit` prints once the commit exists.
 *
 * The title line, then the counts and `--summary` lines that `commitSummary`
 * renders for the change the commit records.
 *
 * @param oid the commit just written
 * @param message its message
 * @param branch the branch it landed on, null when detached
 * @param changes the rendered counts and summary lines
 * @param width how many hex digits to abbreviate the id to
 * @param root whether this is the repository's first commit
 */
export function report(
  oid: string,
  message: string,
  branch: string | null,
  changes: string,
  width: number,
  root: boolean,
): string {
  const title = message.split('\n')[0] ?? ''
  const where = branch ?? 'detached HEAD'
  const marker = root ? ROOT_COMMIT : ''
  return `[${where} ${marker}${short(oid, width)}] ${title}\n${changes}`
}
