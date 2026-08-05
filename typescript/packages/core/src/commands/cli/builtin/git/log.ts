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
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIVerbOpts } from '../../types.ts'
import { GitError } from './errors.ts'
import { entry, oneline } from './format.ts'
import { parseFlags, select } from './history.ts'
import { opened } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, fatal, revisionArg } from './util.ts'

const ENC = new TextEncoder()

/** Show commit logs. */
export async function log(
  _config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  try {
    checkOperands(texts)
    const parsed = parseFlags(fl)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, opts.dispatch)
    const start = await resolveCommit(repo, revisionArg(texts))
    const commits = await select(repo, start, parsed)
    const lines: string[] = []
    if (parsed.oneline) {
      for (const commit of commits) lines.push(oneline(commit, repo.abbrev))
    } else {
      commits.forEach((commit, index) => {
        if (index > 0) lines.push('')
        lines.push(...entry(commit, repo.abbrev))
      })
    }
    if (lines.length === 0) return [null, new IOResult()]
    return [ENC.encode(`${lines.join('\n')}\n`), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
