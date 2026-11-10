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
import { IOResult, type ByteSource, type Rows } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { branchUpstream } from './branch.ts'
import { assembled, collect, RENAME_THRESHOLD, type StatusRow, UNTRACKED } from './changes.ts'
import { similarity } from './diff_output.ts'
import { GitError } from './errors.ts'
import { configValues } from './fs.ts'
import { readOptional } from './io.ts'
import { namedWhole, narrowedUntracked, pathspecPatterns, pathspecSelects } from './pathspec.ts'
import { detachedLine } from './ref_list.ts'
import { readHead } from './refs.ts'
import { branchLine, longFormat, relativeEntries, shortFormat } from './render.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import type { HeadRef } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { checkSwitches, maybeBool, startPoint, requireVfs } from './util.ts'
import { repoRelative } from './pathspec.ts'
import { UNTRACKED_ALL, UNTRACKED_NO, UNTRACKED_NORMAL } from './worktree.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/** The parsed shape of a `git status` invocation. */
interface StatusFlags {
  /** `--porcelain`, the stable machine format. */
  readonly porcelain: boolean
  /** `-s`, the same rows meant for a person. */
  readonly short: boolean
  /** `-b`, prepend the `##` branch line. */
  readonly branch: boolean
  /** `-u`, which untracked files to report. */
  readonly untracked: string
  readonly ignored: boolean
  /** `-z`, end entries with NUL. */
  readonly nul: boolean
}

/**
 * Read the raw status flag kwargs into a frozen struct.
 *
 * `-u` carries its mode attached or not at all, and a bare one means `all`,
 * which is why the value is read as a string first and only then as a boolean.
 */
function parseFlags(fl: FlagView): StatusFlags {
  const stated = fl.asStr('untracked_files')
  const mode = stated ?? (fl.asBool('untracked_files') ? UNTRACKED_ALL : UNTRACKED_NORMAL)
  const version = fl.asStr('porcelain')
  if (version != null && !['1', 'v1'].includes(version))
    throw new GitError(`unsupported porcelain version '${version}'`)
  const nul = fl.asBool('null')
  const last = fl.typedOrder('short', 'long', 'porcelain').at(-1) ?? ''
  if (nul && fl.asBool('long'))
    throw new GitError("options '--long' and '-z' cannot be used together")
  return {
    porcelain: last === 'porcelain' || (nul && last !== 'short'),
    short: last === 'short',
    branch: fl.asBool('branch'),
    ignored: fl.asBool('ignored'),
    untracked: mode,
    nul,
  }
}

/** A setting the line can turn on or off and config otherwise decides. */
async function chosen(
  repo: Repo,
  fl: FlagView,
  on: string,
  off: string,
  variable: string,
  fallback: boolean,
): Promise<boolean> {
  const last = fl.typedOrder(on, off).at(-1)
  if (last !== undefined) return last === on
  return configBool(repo, `status.${variable}`, fallback)
}

/** The similarity a status rename needs, null for no pairing. */
async function renameThreshold(repo: Repo, fl: FlagView): Promise<number | null> {
  const last = fl.typedOrder('renames', 'no_renames', 'find_renames').at(-1)
  if (last === 'no_renames') return null
  if (last === 'find_renames') {
    const value = fl.raw('find_renames')
    return typeof value === 'string' && value !== '' ? similarity(value) : 50
  }
  if (last !== undefined) return RENAME_THRESHOLD
  const values = await configValues(repo.vfs, repo.location, 'status.renames')
  const value = values.at(-1)
  return value !== undefined && maybeBool(value) === false ? null : RENAME_THRESHOLD
}

/** How many stashes the repository holds. */
async function stashCount(repo: Repo): Promise<number> {
  const data = await readOptional(repo.vfs, repo.location.commondir.join('logs/refs/stash'))
  if (data === null) return 0
  return new TextDecoder()
    .decode(data)
    .split('\n')
    .filter((row) => row !== '').length
}

/**
 * Where a person's status report names paths from, relative to the work tree;
 * empty for paths named from its root.
 *
 * git's human formats name paths from the invocation directory unless
 * `status.relativePaths` is false; porcelain never does. From outside the work
 * tree they stay relative to its root. Mirrors Python's `relative_prefix`.
 */
async function relativePrefix(repo: Repo, start: string): Promise<string> {
  if (!(await configBool(repo, 'status.relativePaths', true))) return ''
  return repoRelative(repo.location, start, '.')
}

/**
 * The default status report, as rows and their renderer.
 *
 * Split out so `commit` can print it when it has nothing to commit: git shows
 * the whole status there rather than a one-line refusal, and two renderings of
 * the same thing would drift. Its paths are relative to `start`, where git runs.
 */
export async function reportRows(
  repo: Repo,
  vfs: Files,
  head: HeadRef,
  start: string,
): Promise<Rows<StatusRow>> {
  const [rows, state, noCommits] = await collect(repo, vfs, UNTRACKED_NORMAL)
  const fully = await configBool(repo, 'core.quotepath', true)
  const detached = head.branch !== null ? '' : await detachedLine(repo, head)
  const upstream = await branchUpstream(repo, head, noCommits)
  const prefix = await relativePrefix(repo, start)
  const render = async (shown: StatusRow[]): Promise<ByteSource> =>
    encodeText(
      longFormat(
        relativeEntries(await assembled(repo, shown), prefix),
        head.branch,
        detached,
        noCommits,
        state.merging,
        false,
        fully,
        upstream,
      ),
    )
  return { items: rows, render }
}

/** The rows a pathspec keeps, reading inside any untracked directory it does not name whole. */
async function selectedRows(
  repo: Repo,
  vfs: Files,
  rows: readonly StatusRow[],
  showIgnored: boolean,
  patterns: readonly string[],
): Promise<StatusRow[]> {
  const kept = rows.filter(
    (row) =>
      row.indexStatus !== UNTRACKED && pathspecSelects(row.name.replace(/\/$/, ''), patterns),
  )
  const names = rows.filter((row) => row.indexStatus === UNTRACKED).map((row) => row.name)
  let files: string[] = []
  if (names.some((name) => name.endsWith('/') && !namedWhole(name.slice(0, -1), patterns))) {
    const [every] = await collect(repo, vfs, UNTRACKED_ALL, showIgnored)
    files = every.filter((row) => row.indexStatus === UNTRACKED).map((row) => row.name)
  }
  return [
    ...kept,
    ...narrowedUntracked(names, files, patterns).map((name): StatusRow => ({
      path: repo.location.worktree.join(name.replace(/\/$/, '')),
      name,
      indexStatus: UNTRACKED,
      treeStatus: UNTRACKED,
      end: null,
      unmerged: false,
    })),
  ]
}

/**
 * Show the working tree status.
 *
 * Three sources, compared pairwise: HEAD's tree against the index says what a
 * commit would record, and the index against the working tree says what it would
 * leave behind. Everything the report prints is one of those two answers, or a
 * path neither side knows about. Each path is handed over as a row, so the
 * report names and counts only the paths the session sees.
 */
export async function status(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
  const parsed = parseFlags(fl)
  checkSwitches(ctx, texts)
  const repo = await opened(ctx, fl, true)
  const head = await readHead(vfs, repo.location.gitdir)
  const start = startPoint(fl).virtual
  const patterns = pathspecPatterns(repo.location, start, texts)
  const showStash = await chosen(repo, fl, 'show_stash', 'no_show_stash', 'showStash', false)
  const aheadBehind = await chosen(repo, fl, 'ahead_behind', 'no_ahead_behind', 'aheadBehind', true)
  const threshold = await renameThreshold(repo, fl)
  const [collected, state, noCommits] = await collect(repo, vfs, parsed.untracked, parsed.ignored)
  const rows = patterns.length
    ? await selectedRows(repo, vfs, collected, parsed.ignored, patterns)
    : collected
  const fully = await configBool(repo, 'core.quotepath', true)
  const prefix = parsed.porcelain ? '' : await relativePrefix(repo, start)
  const stashes = showStash ? await stashCount(repo) : 0
  const upstream = await branchUpstream(repo, head, noCommits)
  const detached = head.branch !== null ? '' : await detachedLine(repo, head)
  const render = async (shown: StatusRow[]): Promise<ByteSource> => {
    const entries = relativeEntries(await assembled(repo, shown, threshold), prefix)
    let body =
      parsed.porcelain || parsed.short
        ? shortFormat(
            entries,
            parsed.branch ? branchLine(head.branch, noCommits, upstream, aheadBehind) : null,
            fully,
            parsed.nul,
          )
        : longFormat(
            entries,
            head.branch,
            detached,
            noCommits,
            state.merging,
            parsed.untracked === UNTRACKED_NO,
            fully,
            upstream,
            aheadBehind,
          )
    if (stashes > 0 && !parsed.porcelain && !parsed.short)
      body += `Your stash currently has ${String(stashes)} ${stashes === 1 ? 'entry' : 'entries'}\n`
    return encodeText(body)
  }
  return [null, new IOResult({ rows: { items: rows, render } })]
}
