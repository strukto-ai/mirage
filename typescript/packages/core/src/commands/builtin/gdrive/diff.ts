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

import type { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { resolveGlob } from '../../../core/gdrive/glob.ts'
import { readdir as gdriveReaddir } from '../../../core/gdrive/readdir.ts'
import { stat as gdriveStat } from '../../../core/gdrive/stat.ts'
import { stream as gdriveStream } from '../../../core/gdrive/read.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { diffGeneric } from '../generic/diff.ts'

async function diffCommand(
  accessor: GDriveAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return diffGeneric(
    resolved,
    opts,
    (p) => gdriveStream(accessor, p, opts.index ?? undefined),
    (p) => gdriveReaddir(accessor, p, opts.index ?? undefined),
    (p) => gdriveStat(accessor, p, opts.index ?? undefined),
  )
}

export const GDRIVE_DIFF = command({
  name: 'diff',
  resource: ResourceName.GDRIVE,
  spec: specOf('diff'),
  fn: diffCommand,
})
