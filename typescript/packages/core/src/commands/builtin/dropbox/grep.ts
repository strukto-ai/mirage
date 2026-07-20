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
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { defaultProvision } from '../generic_bind/provision.ts'
import { patternArg } from '../grep_helper.ts'
import { grepGeneric } from '../generic/grep.ts'
import { DROPBOX_IO } from './io.ts'
import { narrowScope } from './narrow.ts'

const dropboxResolveGlob = resolveGlobOf(DROPBOX_IO)

async function grepCommand(
  accessor: DropboxAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let resolved: PathSpec[] = []
  if (paths.length > 0) {
    const pattern = patternArg(texts, opts.flags)
    // -v and -c need the walk: GNU prints non-matching lines (-v) and zero
    // counts (-c) from files a narrowed superset would never visit.
    const narrowed = await narrowScope(accessor, paths, pattern, {
      fixedString: opts.flags.F === true,
      recursive: opts.flags.r === true || opts.flags.R === true,
      exactFileSet: opts.flags.v === true || opts.flags.c === true,
      ...(opts.index !== null ? { index: opts.index } : {}),
    })
    resolved = narrowed.resolved
    if (narrowed.usedSearch && resolved.length === 0) {
      return [new Uint8Array(), new IOResult({ exitCode: 1 })]
    }
  }
  const stat = (p: PathSpec): Promise<FileStat> => dropboxStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    dropboxReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    dropboxStream(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, stream)
}

export const DROPBOX_GREP = command({
  name: 'grep',
  resource: ResourceName.DROPBOX,
  spec: specOf('grep'),
  fn: grepCommand,
  // Same cost estimate the generic-bound grep carried; narrowing only
  // ever lowers the real cost below it.
  provision: defaultProvision('grep', DROPBOX_IO.stat, dropboxResolveGlob, DROPBOX_IO.readdir),
})
