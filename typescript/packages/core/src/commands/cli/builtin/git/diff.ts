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

import { headEntries, stagedEntries, workEntries } from './changes.ts'
import { readIndex, refuseUnresolved } from './index_file.ts'
import { commitEntries, treeEntries, type TreeEntry } from './tree.ts'
import { compare, limited, renderChanges } from './diff_output.ts'
import { HEAD } from './constants.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  GitError,
  InvalidOptionError,
  NoMergeBaseError,
  NoWorkspaceError,
  UsageError,
} from './errors.ts'
import { parseDiffFlags, renamesEnabled } from './diff_output.ts'
import { pathspecPatterns } from './pathspec.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { mergeBases, rangeCommits, resolveCommit } from './revparse.ts'
import { fatal, optionOperand, splitMarked, startPoint, STDERR, verbUsage } from './util.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const ENC = new TextEncoder()

type Tree = Map<string, TreeEntry>

/**
 * The two sides a diff compares, and any warning.
 *
 * No revision compares the index with the working tree, one compares that
 * revision with it, and two compare them with each other: the old side is null
 * for the index, the new one for the working tree. `A..B` is the two-revision
 * form written as one operand, and `A...B` compares B with the merge base of
 * the two, which is what a branch changed since it forked; with several bases
 * git warns and takes the first (pinned against git 2.50).
 */
async function sides(
  repo: Repo,
  texts: readonly string[],
): Promise<[Tree | null, Tree | null, string]> {
  const first = texts[0]
  if (first === undefined) return [null, null, '']
  const ends = texts.length === 1 ? await rangeCommits(repo, first) : null
  if (ends === null) {
    const second = texts[1]
    return [
      await commitEntries(repo, await resolveCommit(repo, first)),
      second === undefined ? null : await commitEntries(repo, await resolveCommit(repo, second)),
      '',
    ]
  }
  const [left, right, symmetric] = ends
  const after = await treeEntries(repo, right.tree)
  if (!symmetric) return [await treeEntries(repo, left.tree), after, '']
  const bases = await mergeBases(repo, left, right)
  const base = bases[0]
  if (base === undefined) throw new NoMergeBaseError(first)
  const warning =
    bases.length > 1 ? `warning: ${first}: multiple merge bases, using ${base.oid}\n` : ''
  return [await treeEntries(repo, base.tree), after, warning]
}

/**
 * Diff the working tree, staged content or commits.
 *
 * No revision compares the index with the working tree, and one compares that
 * revision with it, as git does; two diff against each other. The index is
 * compared with the named revision under --cached or --staged, defaulting to
 * HEAD or the empty tree on an unborn branch. Operands after `--` are
 * pathspecs, read once the revisions have resolved, as git reads them, and
 * every format shows only the paths they name.
 */
export async function diff(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  const cached = fl.asBool('cached') || fl.asBool('staged')
  const [revisions, paths] = splitMarked(texts, inv.argv)
  try {
    const statPath = doors.statPath
    if (statPath === undefined || doors.dispatch === undefined) throw new NoWorkspaceError()
    const word = optionOperand(inv, texts, STDERR)
    if (word !== null && (cached || revisions.some((text) => !text.startsWith('-')))) {
      throw new UsageError('', verbUsage(inv))
    }
    if (word !== null) throw new InvalidOptionError(word, verbUsage(inv))
    const repo = await opened(fl, doors)
    const parsed = parseDiffFlags(
      fl,
      true,
      'off',
      true,
      await renamesEnabled(repo),
      await configBool(repo, 'core.quotepath', true),
    )
    let before: Tree, after: Tree
    let warning = ''
    if (cached) {
      if (revisions.length > 1) throw new GitError('--cached accepts at most one revision')
      const state = await readIndex(repo, repo.dispatch)
      refuseUnresolved(state)
      before = revisions.length
        ? await commitEntries(repo, await resolveCommit(repo, revisions[0] ?? HEAD))
        : ((await headEntries(repo)) ?? new Map<string, TreeEntry>())
      after = stagedEntries(state)
    } else {
      const [old, fresh, note] = await sides(repo, revisions)
      warning = note
      if (fresh === null) {
        const state = await readIndex(repo, repo.dispatch)
        after = await workEntries(repo, repo.dispatch, statPath, state, doors.ns?.links ?? null)
        if (old === null) for (const path of state.conflicts.keys()) after.delete(path)
        before = old ?? stagedEntries(state)
      } else {
        before = old ?? new Map<string, TreeEntry>()
        after = fresh
      }
    }
    const pathspecs = pathspecPatterns(repo.location, startPoint(fl), paths)
    const flags = { ...parsed, pathspecs }
    const body = await renderChanges(
      repo,
      await compare(repo, limited(before, pathspecs), limited(after, pathspecs), flags.renames),
      flags,
    )
    const result = warning ? new IOResult({ stderr: ENC.encode(warning) }) : new IOResult()
    if (body === '') return [null, result]
    return [encodeText(body), result]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
