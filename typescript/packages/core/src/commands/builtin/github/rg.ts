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
import { type FileStat, VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { patternArg } from '../grep_pattern.ts'
import {
  labelled,
  needsEveryFile,
  parseFlags,
  refuseMissingPattern,
  rgGeneric,
  walkFilter,
} from '../generic/rg.ts'
import { walkCandidates } from '../rg_scan.ts'
import { narrowScope, scopeRefusal } from './pushdown.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()

async function rgCommand(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let resolved: PathSpec[] = []
  let runOpts = opts
  const pattern = patternArg(texts, opts.flags, 'regexp')
  const fl = new FlagView(opts.flags, specOf('rg'))
  const f = parseFlags(fl)
  const refused = refuseMissingPattern(pattern, fl, f)
  if (refused !== null) return refused
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const narrowed = await narrowScope(
      accessor,
      paths,
      pattern,
      f.fixedString,
      true,
      f.wholeWord,
      opts.index ?? undefined,
      // A narrowing holds only files matching the searched literal: -v and
      // --files-without-match print from the rest, and -f adds patterns code
      // search never saw.
      needsEveryFile(fl, f),
    )
    resolved = narrowed.resolved
    if (narrowed.usedSearch) {
      // The candidates stand in for the walk, so they pass its filters (-g,
      // -t, hidden entries, -d); none left means nothing matched, not a stdin
      // run.
      resolved = walkCandidates(resolved, paths, walkFilter(f), opts.cwd)
      if (resolved.length === 0) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
      runOpts = labelled(opts)
    }
    // A scope this large with no trusted narrowing is refused rather than
    // scanned blob by blob; a listing reads no blob.
    if (narrowed.fileCount > SCOPE_ERROR && !(f.listFiles || f.typeList)) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(scopeRefusal('rg', narrowed.fileCount, f.wholeWord)),
        }),
      ]
    }
  }
  const stat = (p: PathSpec): Promise<FileStat> => githubStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    githubReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    githubStream(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, runOpts, stat, readdir, stream)
}

export const GITHUB_RG = command({
  name: 'rg',
  vfs: VFSName.GITHUB,
  spec: specOf('rg'),
  fn: rgCommand,
})
