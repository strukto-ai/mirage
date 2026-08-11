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

import git from 'isomorphic-git'

import { getOpcodes } from '../../../builtin/diff_helper.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { short } from './format.ts'
import { repoArgs, type Repo } from './repo.ts'
import type { TreeEntry } from './tree.ts'

const ROOT_COMMIT = '(root-commit) '
const CREATE = 'create'
const DELETE = 'delete'
// git's diffstat geometry for piped output: 80 columns total, binary
// sniffing over the first 8000 bytes, and the 3/8 cap that splits the
// line between the name column and the +/- graph (diff.c show_stats).
const STAT_WIDTH = 80
const BINARY_SNIFF = 8000
const GRAPH_MIN = 6
const ELLIPSIS = '...'

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
 * absent from this store; it reads as empty rather than failing the whole
 * table.
 */
async function blobData(repo: Repo, oid: string | null): Promise<Uint8Array> {
  if (oid === null) return new Uint8Array(0)
  try {
    const { blob } = await git.readBlob({ ...repoArgs(repo), oid })
    return blob
  } catch {
    return new Uint8Array(0)
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
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
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

/** git's scale_linear: proportional, but never rounding to zero. */
function scale(value: number, width: number, maxChange: number): number {
  if (value === 0) return 0
  return 1 + Math.floor((value * (width - 1)) / maxChange)
}

/**
 * A path fitted to the name column, elided from the left.
 *
 * git keeps the tail of a long path, advanced to the next component boundary,
 * behind a three-dot prefix.
 */
function statName(path: string, nameWidth: number): string {
  if (path.length <= nameWidth) return path
  let tail = path.slice(-(nameWidth - ELLIPSIS.length))
  const slash = tail.indexOf('/')
  if (slash !== -1) tail = tail.slice(slash)
  return `${ELLIPSIS}${tail}`
}

/**
 * git's diffstat table: one row per path, then the summary line.
 *
 * The geometry is diff.c's show_stats pinned against git 2.50 at the piped
 * default of 80 columns: the graph is capped at three eighths of the line,
 * the name column takes what remains, and per-file graphs scale linearly with
 * a floor of one mark per nonzero side.
 */
export function statTable(stats: readonly FileStat[], width: number = STAT_WIDTH): string[] {
  if (stats.length === 0) return []
  const maxLen = Math.max(...stats.map((stat) => stat.path.length))
  const changes = stats.filter((s) => !s.binary).map((s) => s.insertions + s.deletions)
  const maxChange = changes.length > 0 ? Math.max(...changes) : 0
  const numberWidth = maxChange > 0 ? String(maxChange).length : 1
  const binWidths = stats
    .filter((s) => s.binary)
    .map((s) => `Bin ${String(s.oldSize)} -> ${String(s.newSize)} bytes`.length - 4)
  const binWidth = binWidths.length > 0 ? Math.max(...binWidths) : 0
  const budget = Math.max(width, 16 + 6 + numberWidth)
  let graphWidth = maxChange > binWidth ? maxChange : binWidth
  let nameWidth = maxLen
  if (nameWidth + numberWidth + 6 + graphWidth > budget) {
    const cap = Math.floor((budget * 3) / 8) - numberWidth - 6
    if (graphWidth > cap) graphWidth = Math.max(cap, GRAPH_MIN)
    if (nameWidth > budget - numberWidth - 6 - graphWidth) {
      nameWidth = budget - numberWidth - 6 - graphWidth
    } else {
      graphWidth = budget - numberWidth - 6 - nameWidth
    }
  }
  const lines: string[] = []
  let totalInsertions = 0
  let totalDeletions = 0
  for (const stat of stats) {
    const name = statName(stat.path, nameWidth).padEnd(nameWidth)
    if (stat.binary) {
      lines.push(` ${name} | Bin ${String(stat.oldSize)} -> ${String(stat.newSize)} bytes`)
      continue
    }
    totalInsertions += stat.insertions
    totalDeletions += stat.deletions
    const change = stat.insertions + stat.deletions
    let added = stat.insertions
    let removed = stat.deletions
    if (change > 0 && graphWidth <= maxChange) {
      let total = scale(change, graphWidth, maxChange)
      if (total < 2 && added > 0 && removed > 0) total = 2
      if (added < removed) {
        added = scale(added, graphWidth, maxChange)
        removed = total - added
      } else {
        removed = scale(removed, graphWidth, maxChange)
        added = total - removed
      }
    }
    const graph = change > 0 ? ` ${'+'.repeat(added)}${'-'.repeat(removed)}` : ''
    lines.push(` ${name} | ${String(change).padStart(numberWidth)}${graph}`)
  }
  lines.push(statLine(stats.length, totalInsertions, totalDeletions))
  return lines
}

/** `N noun` with the noun pluralised the way git pluralises it. */
function plural(count: number, noun: string): string {
  return count === 1 ? `${String(count)} ${noun}` : `${String(count)} ${noun}s`
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

/** The `create mode` / `delete mode` lines, in git's order. */
function modeLines(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): string[] {
  const lines: string[] = []
  for (const path of [...after.keys()].filter((p) => !before.has(p)).sort()) {
    lines.push(` ${CREATE} mode ${after.get(path)?.mode ?? ''} ${path}`)
  }
  for (const path of [...before.keys()].filter((p) => !after.has(p)).sort()) {
    lines.push(` ${DELETE} mode ${before.get(path)?.mode ?? ''} ${path}`)
  }
  return lines
}

/**
 * What `git commit` prints once the commit exists.
 *
 * The counts come from `diffstat`, so a binary file adds to the file total
 * but zero lines, exactly as git reports it.
 *
 * @param repo the opened repository
 * @param oid the commit just written
 * @param message its message
 * @param branch the branch it landed on, null when detached
 * @param before the parent tree
 * @param after the new tree
 * @param width how many hex digits to abbreviate the id to
 * @param root whether this is the repository's first commit
 */
export async function report(
  repo: Repo,
  oid: string,
  message: string,
  branch: string | null,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  width: number,
  root: boolean,
): Promise<string> {
  const stats = await diffstat(repo, before, after)
  const title = message.split('\n')[0] ?? ''
  const where = branch ?? 'detached HEAD'
  const marker = root ? ROOT_COMMIT : ''
  const lines = [`[${where} ${marker}${short(oid, width)}] ${title}`]
  if (stats.length > 0) {
    const insertions = stats.reduce((sum, stat) => sum + stat.insertions, 0)
    const deletions = stats.reduce((sum, stat) => sum + stat.deletions, 0)
    lines.push(statLine(stats.length, insertions, deletions))
  }
  lines.push(...modeLines(before, after))
  return lines.map((line) => `${line}\n`).join('')
}
