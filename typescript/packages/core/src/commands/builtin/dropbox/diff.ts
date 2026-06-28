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
import { resolveGlob } from '../../../core/dropbox/glob.ts'
import { readdir as dropboxReaddir } from '../../../core/dropbox/readdir.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { stream as dropboxStream } from '../../../core/dropbox/read.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { diffGeneric } from '../generic/diff.ts'

async function diffCommand(
  accessor: DropboxAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    dropboxStream(accessor, p, opts.index ?? undefined)
  return diffGeneric(
    resolved,
    opts,
    stream,
    (p) => dropboxReaddir(accessor, p, opts.index ?? undefined),
    (p) => dropboxStat(accessor, p, opts.index ?? undefined),
  )
}

export const DROPBOX_DIFF = command({
  name: 'diff',
  resource: ResourceName.DROPBOX,
  spec: specOf('diff'),
  fn: diffCommand,
})
