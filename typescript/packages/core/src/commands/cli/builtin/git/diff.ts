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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { headEntries, stagedEntries, workEntries } from './changes.ts'
import { readIndex, refuseUnresolved } from './index_file.ts'
import { commitEntries, treeEntries, type TreeEntry } from './tree.ts'
import { compare, limited, renderChanges, parseDiffFlags, renamesEnabled } from './diff_output.ts'
import { HEAD } from './constants.ts'

import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  GitError,
  InvalidOptionError,
  NoMergeBaseError,
  NoWorkspaceError,
  UsageError,
} from './errors.ts'
import { pathspecPatterns } from './pathspec.ts'
import { configBool, type Repo } from './repo.ts'
import { deltas, shownSides, type Delta } from './rows.ts'
import { shownEntries } from './seen.ts'
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
      shownEntries(repo, await commitEntries(repo, await resolveCommit(repo, first))),
      second === undefined
        ? null
        : shownEntries(repo, await commitEntries(repo, await resolveCommit(repo, second))),
      '',
    ]
  }
  const [left, right, symmetric] = ends
  const after = shownEntries(repo, await treeEntries(repo, right.tree))
  if (!symmetric) return [shownEntries(repo, await treeEntries(repo, left.tree)), after, '']
  const bases = await mergeBases(repo, left, right)
  const base = bases[0]
  if (base === undefined) throw new NoMergeBaseError(first)
  const warning =
    bases.length > 1 ? `warning: ${first}: multiple merge bases, using ${base.oid}\n` : ''
  return [shownEntries(repo, await treeEntries(repo, base.tree)), after, warning]
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
export async function diff(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const cached = fl.asBool('cached') || fl.asBool('staged')
  const [revisions, marked] = splitMarked(texts, ctx.argv ?? [])
  try {
    const vfs = ctx.vfs
    if (vfs === undefined) throw new NoWorkspaceError()
    const word = optionOperand(ctx, texts, STDERR)
    if (word !== null && (cached || revisions.some((text) => !text.startsWith('-')))) {
      throw new UsageError('', verbUsage(ctx))
    }
    if (word !== null) throw new InvalidOptionError(word, verbUsage(ctx))
    const repo = await opened(ctx, fl)
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
      const state = await readIndex(repo, repo.vfs)
      refuseUnresolved(state)
      before = shownEntries(
        repo,
        revisions.length
          ? await commitEntries(repo, await resolveCommit(repo, revisions[0] ?? HEAD))
          : ((await headEntries(repo)) ?? new Map<string, TreeEntry>()),
      )
      after = stagedEntries(state)
    } else {
      const [old, fresh, note] = await sides(repo, revisions)
      warning = note
      if (fresh === null) {
        const state = await readIndex(repo, repo.vfs)
        after = await workEntries(repo, vfs, state)
        if (old === null) for (const path of state.conflicts.keys()) after.delete(path)
        before = old ?? stagedEntries(state)
      } else {
        before = old ?? new Map<string, TreeEntry>()
        after = fresh
      }
    }
    const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, marked)
    const flags = { ...parsed, pathspecs }
    const rows = deltas(repo.location, [[limited(before, pathspecs), limited(after, pathspecs)]])
    const render = async (shown: Delta[]): Promise<ByteSource | null> => {
      const [oldSide, newSide] = shownSides(shown, 1)[0] ?? [new Map(), new Map()]
      const body = await renderChanges(
        repo,
        await compare(repo, oldSide, newSide, flags.renames),
        flags,
      )
      return body === '' ? null : encodeText(body)
    }
    return [
      null,
      new IOResult({
        ...(warning ? { stderr: ENC.encode(warning) } : {}),
        rows: { items: rows, render },
      }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
