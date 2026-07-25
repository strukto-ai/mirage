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
  ResourceName,
  command,
  cpGeneric,
  parseCpFlags,
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { copy as coreCopy } from '../../../core/opfs/copy.ts'
import { find as coreFind } from '../../../core/opfs/find.ts'
import { mkdir as coreMkdir } from '../../../core/opfs/mkdir.ts'
import { readdir as coreReaddir } from '../../../core/opfs/readdir.ts'
import { stat as coreStat } from '../../../core/opfs/stat.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

function cpCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseCpFlags(opts.flags)
  const overlay = opts.statOverlay
  // -u freshness must see the namespace attr overlay (touch on overlay
  // backends, where OPFS has no setattr op), exactly like ls -l does;
  // the raw OPFS stat only reports the write wall-clock.
  const stat =
    overlay !== undefined
      ? async (p: PathSpec) => overlay(p.virtual, await coreStat(accessor, p))
      : (p: PathSpec) => coreStat(accessor, p)
  return cpGeneric(
    paths,
    stat,
    {
      copy: (src: PathSpec, target: PathSpec) => coreCopy(accessor, src, target),
      find: (src, options) => coreFind(accessor, src, options),
      mkdir: (p: PathSpec) => coreMkdir(accessor, p),
    },
    parsed,
    opts.index ?? undefined,
    undefined,
    (p: PathSpec) => coreReaddir(accessor, p),
  )
}

export const OPFS_CP = command({
  name: 'cp',
  resource: ResourceName.OPFS,
  spec: specOf('cp'),
  fn: cpCommand,
  write: true,
})
