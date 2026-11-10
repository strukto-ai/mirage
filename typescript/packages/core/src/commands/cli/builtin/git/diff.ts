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
import {
  compare,
  limited,
  renderChanges,
  parseDiffFlags,
  renamesEnabled,
  filtered,
  prefixConfig,
  type DiffFlags,
} from './diff_output.ts'
import { HEAD } from './constants.ts'

import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { GitError, InvalidOptionError, NoMergeBaseError, UsageError } from './errors.ts'
import { exists } from './io.ts'
import { absoluteOperand, pathspecPatterns, patternRoots } from './pathspec.ts'
import { configBool, type Repo } from './repo.ts'
import { deltas, shownSides, type Delta } from './rows.ts'
import { shownEntries } from './seen.ts'
import { opened } from './session.ts'
import { mergeBases, rangeCommits, resolveCommit, resolveObject, treeId } from './revparse.ts'
import {
  loneHelp,
  optionOperand,
  splitMarked,
  startPoint,
  STDERR,
  verbUsage,
  requireVfs,
} from './util.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const ENC = new TextEncoder()

type Tree = Map<string, TreeEntry>
// What makes a word a pattern git reads as a path unseen.
const WILDCARDS = '*?[\\'

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
  const vfs = requireVfs(ctx)
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
    await prefixConfig(repo),
  )
  let before: Tree, after: Tree
  let indexSide: Tree = new Map()
  let workTree = false
  let warning = ''
  const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, marked)
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
    after = shownEntries(repo, stagedEntries(state))
  } else {
    const [old, fresh, note] = await sides(repo, revisions)
    warning = note
    if (fresh === null) {
      const state = await readIndex(repo, repo.vfs)
      after = await workEntries(repo, vfs, state, patternRoots(pathspecs))
      if (old === null) for (const path of state.conflicts.keys()) after.delete(path)
      indexSide = shownEntries(repo, stagedEntries(state))
      before = old ?? indexSide
      workTree = true
    } else {
      before = old ?? new Map<string, TreeEntry>()
      after = fresh
    }
  }
  return compared(
    repo,
    { ...parsed, pathspecs, workTree, sameAsIndex: sameAsIndex(indexSide, after) },
    [before, after],
    fl,
    warning,
  )
}

function sameAsIndex(index: Tree, work: Tree): ReadonlySet<string> {
  const same = new Set<string>()
  for (const [path, side] of work) {
    const held = index.get(path)
    if (held?.oid === side.oid && held.mode === side.mode) same.add(path)
  }
  return same
}

/** Answer one comparison: its rows, and exit 1 when asked whether anything differs. */
function compared(
  repo: Repo,
  flags: DiffFlags,
  sides: readonly [Tree, Tree],
  fl: FlagView,
  warning = '',
): CommandFnResult {
  const quiet = fl.asBool('quiet')
  const report = quiet || fl.asBool('exit_code')
  const rows = deltas(repo.location, [
    [limited(sides[0], flags.pathspecs), limited(sides[1], flags.pathspecs)],
  ])
  const render = async (shown: Delta[]): Promise<ByteSource | null> => {
    const [oldSide, newSide] = shownSides(shown, 1)[0] ?? [new Map(), new Map()]
    const changes = await compare(repo, oldSide, newSide, flags.renames)
    if (report && filtered(changes, flags).length) io.exitCode = 1
    if (quiet) return null
    const body = await renderChanges(repo, changes, flags)
    return body === '' ? null : encodeText(body)
  }
  const io = new IOResult({
    ...(warning ? { stderr: ENC.encode(warning) } : {}),
    rows: { items: rows, render },
  })
  return [null, io]
}

/**
 * Refuse a bare word a plumbing diff cannot read as a path. With no `--` a word
 * that exists, or a pattern, is a path; one that names a revision is a misuse,
 * and anything else is unknown.
 */
async function pathOperands(
  ctx: Context,
  fl: FlagView,
  repo: Repo,
  words: readonly string[],
): Promise<void> {
  const start = startPoint(fl).virtual
  for (const word of words) {
    if ([...WILDCARDS].some((char) => word.includes(char))) continue
    if (await exists(repo.vfs, PathSpec.fromStrPath(absoluteOperand(start, word)))) continue
    await resolveObject(repo, word)
    throw new UsageError('', verbUsage(ctx))
  }
}

async function plumbingFlags(fl: FlagView, repo: Repo): Promise<DiffFlags> {
  return parseDiffFlags(
    fl,
    false,
    'off',
    false,
    false,
    await configBool(repo, 'core.quotepath', true),
    await prefixConfig(repo),
  )
}

/** `git diff-files`: compare the index with the working tree, in plumbing's defaults. */
export async function diffFiles(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const vfs = requireVfs(ctx)
  const fl = new FlagView(ctx.flags)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const [words, marked] = splitMarked(texts, ctx.argv ?? [])
  const repo = await opened(ctx, fl, true)
  await pathOperands(ctx, fl, repo, words)
  const parsed = await plumbingFlags(fl, repo)
  const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, [...words, ...marked])
  const state = await readIndex(repo, repo.vfs)
  const after = await workEntries(repo, vfs, state, patternRoots(pathspecs))
  for (const path of state.conflicts.keys()) after.delete(path)
  const before = shownEntries(repo, stagedEntries(state))
  return compared(repo, { ...parsed, pathspecs, workTree: true }, [before, after], fl)
}

/**
 * `git diff-index`: compare a tree with the working tree, or with the index. A
 * file staged and left alone reports the staged id; only one that differs from
 * the index reports the all-zero id.
 */
export async function diffIndex(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const vfs = requireVfs(ctx)
  const fl = new FlagView(ctx.flags)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const [words, marked] = splitMarked(texts, ctx.argv ?? [])
  const first = words[0]
  if (first === undefined) throw new UsageError('', verbUsage(ctx))
  const cached = fl.asBool('cached')
  const repo = await opened(ctx, fl, !cached)
  const tree = await treeId(repo, first)
  await pathOperands(ctx, fl, repo, words.slice(1))
  const parsed = await plumbingFlags(fl, repo)
  const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, [
    ...words.slice(1),
    ...marked,
  ])
  const before = shownEntries(repo, await treeEntries(repo, tree))
  const state = await readIndex(repo, repo.vfs)
  const staged = shownEntries(repo, stagedEntries(state))
  if (cached) return compared(repo, { ...parsed, pathspecs }, [before, staged], fl)
  const worked = await workEntries(repo, vfs, state, patternRoots(pathspecs))
  const after = fl.asBool('m') ? new Map([...staged, ...worked]) : worked
  return compared(
    repo,
    { ...parsed, pathspecs, workTree: true, sameAsIndex: sameAsIndex(staged, after) },
    [before, after],
    fl,
  )
}
