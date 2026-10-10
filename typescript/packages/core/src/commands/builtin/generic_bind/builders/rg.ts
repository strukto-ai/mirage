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

import { narrowScope, runSearch } from '../search.ts'

import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandIO } from '../../../config.ts'
import { pathsScoped } from '../../../../view/namespace_view.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  filtersFiles,
  labelled,
  needsEveryFile,
  parseFlags,
  rgGeneric,
  walkFilter,
} from '../../generic/rg.ts'
import { patternArg } from '../../grep_pattern.ts'
import { walkCandidates } from '../../rg_scan.ts'
import { type GenericCommand, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'

const rg: GenericCommandFn = async (raw, accessor, paths, texts, opts) => {
  // The service's index answers for every file under a scope, so a
  // narrowing whose scope the caller's view restricts is not taken.
  const ops: CommandIO = { ...raw }
  if (pathsScoped(opts.ns, paths, opts.mountPrefix ?? '')) delete ops.contentSearch
  if (ops.search !== undefined) return runSearch(ops, 'rg', accessor, paths, texts, opts)
  const idx = opts.index ?? undefined
  let resolved: PathSpec[] = []
  let runOpts = opts
  if (paths.length > 0 && ops.contentSearch === undefined) {
    resolved = await resolveGlobOf(ops)(accessor, paths, idx)
  } else if (paths.length > 0) {
    const fl = new FlagView(opts.flags, specOf('rg'))
    const f = parseFlags(fl)
    // -v and the rest of needsEveryFile need the walk (a narrowed superset
    // hides the files they answer for); -g/-t keep the walk so their file
    // filtering stays in one place.
    const narrowed = await narrowScope(
      ops,
      accessor,
      paths,
      patternArg(texts, opts.flags, 'regexp'),
      {
        fixedString: f.fixedString,
        recursive: true,
        wholeWord: f.wholeWord,
        exactFileSet: needsEveryFile(fl, f) || filtersFiles(f),
        index: idx,
      },
    )
    resolved = narrowed.resolved
    if (narrowed.usedSearch) {
      resolved = walkCandidates(resolved, paths, walkFilter(f), opts.cwd)
      if (resolved.length === 0) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
      runOpts = labelled(opts)
    }
  }
  return rgGeneric(
    resolved,
    texts,
    runOpts,
    (p) => ops.stat(accessor, p, idx),
    (p) => ops.readdir(accessor, p, idx),
    (p) => ops.readStream(accessor, p, idx),
  )
}

export const BUILDER: GenericCommand = {
  name: 'rg',
  read: true,
  fn: rg,
}
