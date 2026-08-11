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

import { unifiedDiff } from '../../../builtin/diff_helper.ts'
import { short } from './format.ts'
import { repoArgs, type Repo } from './repo.ts'
import { treeEntries, type TreeEntry } from './tree.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })
// git's blob abbreviation inside an index line is fixed at seven, unlike the
// commit abbreviation, which widens with the repository.
const BLOB_ABBREV = 7
const DEV_NULL = '/dev/null'

// Deliberate divergence, verified against git 2.47.3 on a real repository. The
// patch is correct and applies cleanly, and file headers, mode lines and blob
// abbreviations match git exactly, but the hunks are not byte-identical:
//
//   ours: @@ -3,6 +3,10 @@
//   git:  @@ -4,6 +4,10 @@ from collections import defaultdict
//
// Two causes, both from rendering through a Myers/SequenceMatcher diff rather
// than git's xdiff. git appends the enclosing function or section to a hunk
// header (xfuncname), and git slides a hunk to the equivalent boundary xdiff
// prefers, so a blank line can be attributed to the additions on one side and
// the context on the other. Closing this means reimplementing xdl_change_compact
// and the xfuncname scan; until then do not claim byte parity for diff bodies.
// `log`, `log --oneline`, `show`'s header and `branch` ARE byte-identical.
//
// The same divergence exists on the Python side and for the same reason (its
// dulwich patch writer runs on difflib), so the two implementations agree with
// each other even where both differ from git.

/** Read one blob as lines, keeping the newline on each. */
async function blobLines(repo: Repo, oid: string | null): Promise<string[]> {
  if (oid === null) return []
  const { blob } = await git.readBlob({ ...repoArgs(repo), oid })
  const text = DEC.decode(blob)
  if (text === '') return []
  return text.split(/(?<=\n)/)
}

/** The `index <old>..<new> <mode>` line git puts under the header. */
function indexLine(before: TreeEntry | null, after: TreeEntry | null): string {
  const zero = '0'.repeat(BLOB_ABBREV)
  const old = before === null ? zero : short(before.oid, BLOB_ABBREV)
  const now = after === null ? zero : short(after.oid, BLOB_ABBREV)
  if (before !== null && after !== null && before.mode === after.mode) {
    return `index ${old}..${now} ${after.mode}`
  }
  return `index ${old}..${now}`
}

/** The header lines for one changed path, git's own order. */
function header(path: string, before: TreeEntry | null, after: TreeEntry | null): string[] {
  const lines = [`diff --git a/${path} b/${path}`]
  if (before === null && after !== null) lines.push(`new file mode ${after.mode}`)
  else if (before !== null && after === null) lines.push(`deleted file mode ${before.mode}`)
  else if (before !== null && after !== null && before.mode !== after.mode) {
    lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`)
  }
  lines.push(indexLine(before, after))
  return lines
}

/**
 * Render a patch between two trees, in git's own format.
 *
 * Paths are compared in sorted order, which is what git prints; a path whose
 * blob id is unchanged is skipped even when its mode moved, apart from the mode
 * lines, because there is no content hunk to show.
 *
 * @param repo repository holding the objects
 * @param beforeTree the tree on the minus side, or null for no commit at all
 * @param afterTree the tree on the plus side
 */
export async function treeDiff(
  repo: Repo,
  beforeTree: string | null,
  afterTree: string | null,
): Promise<string> {
  const before =
    beforeTree === null ? new Map<string, TreeEntry>() : await treeEntries(repo, beforeTree)
  const after =
    afterTree === null ? new Map<string, TreeEntry>() : await treeEntries(repo, afterTree)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const out: string[] = []
  for (const path of paths) {
    const old = before.get(path) ?? null
    const now = after.get(path) ?? null
    if (old !== null && now !== null && old.oid === now.oid && old.mode === now.mode) continue
    out.push(...header(path, old, now))
    const oldLines = await blobLines(repo, old?.oid ?? null)
    const newLines = await blobLines(repo, now?.oid ?? null)
    const body = unifiedDiff(
      oldLines,
      newLines,
      old === null ? DEV_NULL : `a/${path}`,
      now === null ? DEV_NULL : `b/${path}`,
    )
    for (const line of body) out.push(line.endsWith('\n') ? line.slice(0, -1) : line)
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}
