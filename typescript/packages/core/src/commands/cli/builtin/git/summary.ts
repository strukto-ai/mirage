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

const DEC = new TextDecoder('utf-8', { fatal: false })

/** A blob's lines, empty when there is no blob on that side. */
async function blobLines(repo: Repo, oid: string | null): Promise<string[]> {
  if (oid === null) return []
  try {
    const { blob } = await git.readBlob({ ...repoArgs(repo), oid })
    const text = DEC.decode(blob)
    return text === '' ? [] : text.split(/(?<=\n)/)
  } catch {
    return []
  }
}

/**
 * How many lines a commit added and removed, over every path.
 *
 * Counted with the same longest-common-subsequence that `diff` uses, so the
 * totals agree with what git prints. They are line counts, not hunk counts: a
 * rewritten line is one insertion and one deletion.
 */
async function countChanges(
  repo: Repo,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): Promise<[number, number]> {
  let insertions = 0
  let deletions = 0
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path) ?? null
    const now = after.get(path) ?? null
    if (old !== null && now !== null && old.oid === now.oid) continue
    const oldLines = await blobLines(repo, old?.oid ?? null)
    const newLines = await blobLines(repo, now?.oid ?? null)
    for (const [tag, i1, i2, j1, j2] of getOpcodes(oldLines, newLines)) {
      if (tag === DiffOpTag.EQUAL) continue
      deletions += i2 - i1
      insertions += j2 - j1
    }
  }
  return [insertions, deletions]
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
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path)?.oid !== after.get(path)?.oid,
  )
  const title = message.split('\n')[0] ?? ''
  const where = branch ?? 'detached HEAD'
  const marker = root ? ROOT_COMMIT : ''
  const lines = [`[${where} ${marker}${short(oid, width)}] ${title}`]
  if (changed.length > 0) {
    const [insertions, deletions] = await countChanges(repo, before, after)
    lines.push(statLine(changed.length, insertions, deletions))
  }
  lines.push(...modeLines(before, after))
  return lines.map((line) => `${line}\n`).join('')
}
