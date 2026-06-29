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

import type { GitHubAccessor } from '../../../accessor/github.ts'
import { SCOPE_ERROR } from '../../../core/github/constants.ts'
import { readdir as githubReaddir } from '../../../core/github/readdir.ts'
import { stat as githubStat } from '../../../core/github/stat.ts'
import { stream as githubStream } from '../../../core/github/read.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { patternArg } from '../grep_helper.ts'
import { rgMatchesFilter } from '../rg_helper.ts'
import { rgGeneric } from '../generic/rg.ts'
import { filesOnlyShortcircuit, narrowScope } from './narrow.ts'

const ENC = new TextEncoder()

async function rgCommand(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let resolved: PathSpec[] = []
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const pattern = patternArg(texts, opts.flags)
    const fixedString = opts.flags.F === true
    const narrowed = await narrowScope(
      accessor,
      paths,
      pattern,
      fixedString,
      true,
      opts.index ?? undefined,
    )
    resolved = narrowed.resolved
    if (narrowed.fileCount > SCOPE_ERROR) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`rg: ${String(narrowed.fileCount)} files in scope, narrow the path\n`),
        }),
      ]
    }
    if (narrowed.usedSearch) {
      const fileType = typeof opts.flags.type === 'string' ? opts.flags.type : null
      const globPattern = typeof opts.flags.glob === 'string' ? opts.flags.glob : null
      const hidden = opts.flags.hidden === true
      const predicate = (p: string): boolean => rgMatchesFilter(p, fileType, globPattern, hidden)
      const short = filesOnlyShortcircuit(opts.flags, pattern, resolved, first, predicate)
      if (short !== null) return short
    }
  }
  const stat = (p: PathSpec): Promise<FileStat> => githubStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    githubReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    githubStream(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, stream)
}

export const GITHUB_RG = command({
  name: 'rg',
  resource: ResourceName.GITHUB,
  spec: specOf('rg'),
  fn: rgCommand,
})
