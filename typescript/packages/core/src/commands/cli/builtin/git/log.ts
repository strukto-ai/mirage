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
import { GitError } from './errors.ts'
import {
  FULL_SHA,
  needsDecorations,
  oneline,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
} from './format.ts'
import { decorations, parseFlags, refCommits, select, type LogFlags } from './history.ts'
import { commitFacts, opened, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, fatal, revisionArg } from './util.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * The text a log invocation prints for its selected commits.
 *
 * `format:` separates entries with a newline and ends without one, and an
 * entry that renders empty still claims its separator, so `--pretty=format:`
 * prints one newline per commit past the first. `tformat:` (and any bare `%`
 * string) terminates every entry, empty ones included - except that an empty
 * template prints nothing at all, which is how `--format=` stays silent.
 * The caller encodes through `encodeText` because `%xHH` names a raw byte.
 * Pinned against git 2.37 and 2.54.
 */
function rendered(
  commits: readonly CommitFacts[],
  flags: LogFlags,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = flags.pretty
  if (fmt.kind === 'oneline') {
    const length = flags.abbrevCommit ? width : FULL_SHA
    const lines = commits.map((commit) => oneline(commit, length))
    return lines.length > 0 ? `${lines.join('\n')}\n` : ''
  }
  if (fmt.kind === 'format' || fmt.kind === 'tformat') {
    const entries = commits.map((commit) =>
      renderTemplate(fmt.template ?? '', commit, width, decor),
    )
    if (fmt.kind === 'tformat') {
      if (fmt.template === null || fmt.template === '') return ''
      return entries.map((text) => `${text}\n`).join('')
    }
    return entries.join('\n')
  }
  const lines: string[] = []
  commits.forEach((commit, index) => {
    if (index > 0) lines.push('')
    lines.push(...presetBlock(commit, fmt.kind, width))
  })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** The starting points a log walks: the revision, plus every ref for --all. */
async function startingPoints(
  repo: Repo,
  revision: string,
  flags: LogFlags,
): Promise<CommitFacts[]> {
  const starts = [await commitFacts(repo, await resolveCommit(repo, revision))]
  if (flags.allRefs) starts.push(...(await refCommits(repo)))
  return starts
}

/** Show commit logs. */
export async function log(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    checkOperands(texts)
    const parsed = parseFlags(fl)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, opts.dispatch)
    const starts = await startingPoints(repo, revisionArg(texts), parsed)
    const commits = await select(repo, starts, parsed)
    const decor = needsDecorations(parsed.pretty) ? await decorations(repo) : null
    const out = rendered(commits, parsed, repo.abbrev, decor)
    if (out === '') return [null, new IOResult()]
    return [encodeText(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
