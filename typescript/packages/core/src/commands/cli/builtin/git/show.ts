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
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIVerbOpts } from '../../types.ts'
import { GitError } from './errors.ts'
import { entry } from './format.ts'
import { treeDiff } from './patch.ts'
import { commitFacts, opened, repoArgs } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, fatal, revisionArg } from './util.ts'

const ENC = new TextEncoder()
const MERGE_PARENTS = 1

// A merge prints no ordinary diff. git renders one against every parent at once
// (`--cc`, the combined format with two prefix columns and `@@@` ranges), which
// comes out empty whenever the merge result matches a parent exactly, so the
// common merge shows only its header. Combined diffs are not implemented, so a
// merge that resolved a conflict shows its header and nothing else rather than a
// patch git would never print.

/** Show one commit: its log entry, then its diff against its parent. */
export async function show(
  _config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  try {
    checkOperands(texts)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, opts.dispatch)
    const oid = await resolveCommit(repo, revisionArg(texts))
    const facts = await commitFacts(repo, oid)
    const head = `${entry(facts, repo.abbrev).join('\n')}\n`
    if (facts.parents.length > MERGE_PARENTS) return [ENC.encode(head), new IOResult()]
    const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
    const first = facts.parents[0]
    const parentTree =
      first === undefined
        ? null
        : (await git.readCommit({ ...repoArgs(repo), oid: first })).commit.tree
    const body = await treeDiff(repo, parentTree, commit.tree)
    return [ENC.encode(body === '' ? head : `${head}\n${body}`), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
