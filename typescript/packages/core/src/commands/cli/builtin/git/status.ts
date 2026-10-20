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
import { assembled, collect, type StatusRow } from './changes.ts'
import { GitError, NoWorkspaceError } from './errors.ts'
import { detachedLine } from './ref_list.ts'
import { readHead } from './refs.ts'
import { branchLine, longFormat, relativeEntries, shortFormat } from './render.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import type { HeadRef } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { fatal, startPoint } from './util.ts'
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
  return {
    porcelain: fl.asBool('porcelain') || fl.asStr('porcelain') != null,
    short: fl.asBool('short'),
    branch: fl.asBool('branch'),
    ignored: fl.asBool('ignored'),
    untracked: mode,
  }
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
  try {
    const vfs = ctx.vfs
    if (vfs === undefined) {
      throw new NoWorkspaceError()
    }
    const parsed = parseFlags(fl)
    const repo = await opened(ctx, fl, true)
    const head = await readHead(vfs, repo.location.gitdir)
    const [rows, state, noCommits] = await collect(repo, vfs, parsed.untracked, parsed.ignored)
    const fully = await configBool(repo, 'core.quotepath', true)
    const prefix = parsed.porcelain ? '' : await relativePrefix(repo, startPoint(fl).virtual)
    const upstream = await branchUpstream(repo, head, noCommits)
    const detached = head.branch !== null ? '' : await detachedLine(repo, head)
    const render = async (shown: StatusRow[]): Promise<ByteSource> => {
      const entries = relativeEntries(await assembled(repo, shown), prefix)
      const body =
        parsed.porcelain || parsed.short
          ? shortFormat(
              entries,
              parsed.branch ? branchLine(head.branch, noCommits, upstream) : null,
              fully,
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
            )
      return encodeText(body)
    }
    return [null, new IOResult({ rows: { items: rows, render } })]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
