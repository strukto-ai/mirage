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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { stream as dropboxStream } from '../../../core/dropbox/read.ts'
import { readdir as dropboxReaddir } from '../../../core/dropbox/readdir.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { patternArg } from '../grep_pattern.ts'
import {
  filtersFiles,
  labelled,
  needsEveryFile,
  parseFlags,
  rgGeneric,
  walkFilter,
} from '../generic/rg.ts'
import { walkCandidates } from '../rg_scan.ts'
import { narrowScope } from './pushdown.ts'
import { FlagView } from '../../spec/flag_view.ts'

async function rgCommand(
  accessor: DropboxAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('rg'))
  let resolved = paths
  let runOpts = opts
  const pattern = patternArg(texts, opts.flags, 'regexp')
  if (paths.length > 0) {
    const f = parseFlags(fl)
    // -v and the rest of needsEveryFile need the walk (a narrowed superset
    // hides the files they answer for); -g/-t keep the walk so their file
    // filtering stays in one place.
    const narrowed = await narrowScope(accessor, paths, pattern, {
      fixedString: f.fixedString,
      recursive: true,
      wholeWord: f.wholeWord,
      exactFileSet: needsEveryFile(fl, f) || filtersFiles(f),
      ...(opts.index !== null ? { index: opts.index } : {}),
    })
    if (narrowed.usedSearch) {
      const visible = walkCandidates(narrowed.resolved, paths, walkFilter(f), opts.cwd)
      if (visible.length === 0) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
      resolved = visible
      runOpts = labelled(opts)
    } else {
      resolved = narrowed.resolved
    }
  }
  const stat = (p: PathSpec): Promise<FileStat> => dropboxStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    dropboxReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    dropboxStream(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, runOpts, stat, readdir, stream)
}

export const DROPBOX_RG = command({
  name: 'rg',
  vfs: VFSName.DROPBOX,
  spec: specOf('rg'),
  fn: rgCommand,
  // Same cost estimate the generic-bound rg carried; narrowing only ever
  // lowers the real cost below it.
})
