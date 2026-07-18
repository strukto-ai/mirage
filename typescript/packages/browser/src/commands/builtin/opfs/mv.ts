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

import {
  IOResult,
  ResourceName,
  command,
  mvGeneric,
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { rename as coreRename } from '../../../core/opfs/rename.ts'
import { stat as coreStat } from '../../../core/opfs/stat.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

function mvCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length < 2) {
    return Promise.resolve([
      null,
      new IOResult({ exitCode: 1, stderr: new TextEncoder().encode('mv: missing operand\n') }),
    ])
  }
  return mvGeneric(
    paths,
    (p: PathSpec) => coreStat(accessor, p),
    { rename: (src: PathSpec, target: PathSpec) => coreRename(accessor, src, target) },
    opts.flags.n === true,
    opts.flags.v === true,
    opts.index ?? undefined,
  )
}

export const OPFS_MV = command({
  name: 'mv',
  resource: ResourceName.OPFS,
  spec: specOf('mv'),
  fn: mvCommand,
  write: true,
})
