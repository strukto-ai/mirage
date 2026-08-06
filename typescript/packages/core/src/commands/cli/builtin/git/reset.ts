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
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { headEntries, workChanges } from './changes.ts'
import {
  AmbiguousArgumentError,
  GitError,
  NoWorkspaceError,
  RevisionResetError,
  UnknownSwitchError,
} from './errors.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { matched, repoRelative } from './pathspec.ts'
import { opened, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import type { TreeEntry } from './tree.ts'
import { checkOperands, fatal, startPoint } from './util.ts'
import { scan, UNTRACKED_NO } from './worktree.ts'

const ENC = new TextEncoder()
const UNSTAGED_HEADER = 'Unstaged changes after reset:'

/**
 * Which fatal an operand that selected no path deserves.
 *
 * Two different mistakes reach here and git words them differently. A typo
 * names neither a revision nor a path, and git calls that ambiguous. A revision
 * names something real that this build cannot reset to, and answering "unknown
 * revision" for a revision it can resolve perfectly well would send the caller
 * looking for the wrong problem.
 */
async function unmatched(repo: Repo, operand: string): Promise<GitError> {
  try {
    await resolveCommit(repo, operand)
  } catch {
    return new AmbiguousArgumentError(operand)
  }
  return new RevisionResetError(operand)
}

/**
 * An index entry putting a path back to what HEAD records.
 *
 * The stat fields are zeroed for the same reason staging zeroes them: a mount
 * serves none of them meaningfully, and git reads a zeroed entry as one whose
 * cache it should not trust rather than as a corrupt one. The size is zero
 * because the blob was never read; every reader here takes that as "not stated".
 */
export function restored(oid: string, mode: number): StagedEntry {
  return { oid, mode, size: 0 }
}

/**
 * Put the index back to what HEAD records, staging nothing.
 *
 * The working tree is never touched: this is `git reset` in its default mixed
 * mode, which unstages. `--hard` is deliberately not offered, because it
 * destroys uncommitted work and there is no reflog here to recover it from.
 *
 * A pathspec limits the reset to those paths, which is how a single file is
 * unstaged.
 */
export async function reset(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  let unstaged: Map<string, string>
  try {
    const dispatch = opts.dispatch
    const statPath = opts.statPath
    if (statPath === undefined || opts.mountRoot === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError)
    const repo = await opened(fl, statPath, opts.mountRoot, dispatch)
    const state = await readIndex(repo, dispatch)
    const tree = (await headEntries(repo)) ?? new Map<string, TreeEntry>()
    const start = startPoint(fl)
    const names = new Set([...tree.keys(), ...state.entries.keys()])
    let selected: Set<string>
    if (texts.length > 0) {
      selected = new Set()
      for (const operand of texts) {
        const hits = matched(names, repoRelative(repo.location, start, operand))
        if (hits.size === 0) throw await unmatched(repo, operand)
        for (const path of hits) selected.add(path)
      }
    } else {
      selected = names
    }
    const staged = new Map<string, StagedEntry>()
    const removed: string[] = []
    for (const name of selected) {
      const recorded = tree.get(name)
      if (recorded === undefined) removed.push(name)
      else staged.set(name, restored(recorded.oid, Number.parseInt(recorded.mode, 8)))
    }
    if (texts.length === 0) removed.push(...state.conflicts.keys())
    await updateIndex(repo, staged, removed)
    const after = await readIndex(repo, dispatch)
    const found = await scan(
      dispatch,
      statPath,
      repo.location,
      new Set(after.entries.keys()),
      UNTRACKED_NO,
    )
    unstaged = await workChanges(repo, dispatch, repo.location.worktree, after.entries, found)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  if (unstaged.size === 0) return [null, new IOResult()]
  const lines = [UNSTAGED_HEADER]
  for (const [path, letter] of [...unstaged.entries()].sort()) lines.push(`${letter}\t${path}`)
  return [ENC.encode(lines.map((line) => `${line}\n`).join('')), new IOResult()]
}
