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
import { IOResult } from '../../../io/types.ts'
import { pathsScoped } from '../../../ops/namespace_view.ts'
import type { PathSpec } from '../../../types.ts'
import { type FileStat } from '../../../types.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { prefixAggregate } from '../aggregators.ts'
import { grepGeneric, labelled } from '../generic/grep.ts'
import type { Builder, CommandIO } from '../generic_bind/adapter.ts'
import { patternArg } from '../grep_pattern.ts'
import { grepNeedsEveryFile } from '../grep_pushdown.ts'
import { narrowScope, scopeRefusal } from './pushdown.ts'

const ENC = new TextEncoder()

async function grep(
  ops: CommandIO<GitHubAccessor>,
  accessor: GitHubAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let resolved: PathSpec[] = []
  // Code search and the core scan answer from the raw repository, so under a
  // hide or a path rule the handler sets search aside and reads through the
  // command guards, which report a refused directory where GNU does and
  // never open a sealed file.
  const scoped = pathsScoped(opts.ns, paths)
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const pattern = patternArg(texts, opts.flags)
    const fl = new FlagView(opts.flags, specOf('grep'))
    const recursive = fl.asBool('r') || fl.asBool('R')
    const fixedString = fl.asBool('F')
    const narrowed = await narrowScope(
      accessor,
      paths,
      pattern,
      fixedString,
      recursive,
      fl.asBool('w'),
      opts.index ?? undefined,
      scoped || grepNeedsEveryFile(fl),
    )
    if (narrowed.usedSearch) opts = labelled(opts)
    resolved = narrowed.resolved
    if (narrowed.usedSearch && resolved.length === 0) {
      return [new Uint8Array(), new IOResult({ exitCode: 1 })]
    }
    if (narrowed.fileCount > SCOPE_ERROR) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(scopeRefusal('grep', narrowed.fileCount, fl.asBool('w'))),
        }),
      ]
    }
  }
  const idx = opts.index ?? undefined
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, idx)
  const readdir = (p: PathSpec): Promise<string[]> => ops.readdir(accessor, p, idx)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> => ops.readStream(accessor, p, idx)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, stream)
}

export const BUILDER: Builder<GitHubAccessor> = {
  name: 'grep',
  read: true,
  fn: grep,
  aggregate: prefixAggregate,
}
