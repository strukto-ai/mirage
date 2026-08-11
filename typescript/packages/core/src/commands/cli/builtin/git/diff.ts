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

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError, InvalidOptionError } from './errors.ts'
import { treeDiff } from './patch.ts'
import { opened, repoArgs, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, fatal } from './util.ts'

const ENC = new TextEncoder()
const HEAD = 'HEAD'

/** The tree one revision names. */
async function treeOf(repo: Repo, revision: string): Promise<string> {
  const oid = await resolveCommit(repo, revision)
  return (await git.readCommit({ ...repoArgs(repo), oid })).commit.tree
}

/**
 * Diff two commits.
 *
 * One revision diffs it against HEAD's tree, two diff against each other. The
 * working tree is not a party to this yet: comparing against it needs the index
 * and the worktree scan, which is where unstaged and staged diffs live.
 */
export async function diff(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  const first = texts[0]
  if (first === undefined) return [null, new IOResult()]
  try {
    checkOperands(texts, InvalidOptionError)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, opts.dispatch)
    const body = await treeDiff(
      repo,
      await treeOf(repo, first),
      await treeOf(repo, texts[1] ?? HEAD),
    )
    if (body === '') return [null, new IOResult()]
    return [ENC.encode(body), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
