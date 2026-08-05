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

import { IOResult } from '../../../../io/types.ts'
import type { StatPath } from '../../../../ops/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { collect } from './changes.ts'
import { GitError, NoWorkspaceError } from './errors.ts'
import { short } from './format.ts'
import { readHead } from './refs.ts'
import { branchLine, longFormat, shortFormat } from './render.ts'
import { opened, type Repo } from './repo.ts'
import type { Dispatch, HeadRef } from './types.ts'
import { fatal } from './util.ts'
import { UNTRACKED_ALL, UNTRACKED_NO, UNTRACKED_NORMAL } from './worktree.ts'

const ENC = new TextEncoder()

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
  return {
    porcelain: fl.asBool('porcelain'),
    short: fl.asBool('short'),
    branch: fl.asBool('branch'),
    untracked: mode,
  }
}

/**
 * The default status report, as a string.
 *
 * Split out so `commit` can print it when it has nothing to commit: git shows
 * the whole status there rather than a one-line refusal, and two renderings of
 * the same thing would drift.
 */
export async function renderReport(
  repo: Repo,
  dispatch: Dispatch,
  statPath: StatPath,
  head: HeadRef,
): Promise<string> {
  const [rows, state, noCommits] = await collect(repo, dispatch, statPath, UNTRACKED_NORMAL)
  const commit = head.commit === null ? null : short(head.commit, repo.abbrev)
  return longFormat(rows, head.branch, commit, noCommits, state.merging, false)
}

/**
 * Show the working tree status.
 *
 * Three sources, compared pairwise: HEAD's tree against the index says what a
 * commit would record, and the index against the working tree says what it would
 * leave behind. Everything the report prints is one of those two answers, or a
 * path neither side knows about.
 */
export async function status(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const fl = new FlagView(inv.flags)
  try {
    const dispatch = opts.dispatch
    const statPath = opts.statPath
    if (statPath === undefined || opts.mountRoot === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    const parsed = parseFlags(fl)
    const repo = await opened(fl, statPath, opts.mountRoot, dispatch)
    const head = await readHead(dispatch, repo.location.gitdir)
    const [rows, state, noCommits] = await collect(repo, dispatch, statPath, parsed.untracked)
    const commit = head.commit === null ? null : short(head.commit, repo.abbrev)
    const body =
      parsed.porcelain || parsed.short
        ? shortFormat(rows, parsed.branch ? branchLine(head.branch, noCommits) : null)
        : longFormat(
            rows,
            head.branch,
            commit,
            noCommits,
            state.merging,
            parsed.untracked === UNTRACKED_NO,
          )
    return [ENC.encode(body), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
