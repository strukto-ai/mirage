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
  metadataProvision,
  resolveGlobOf,
  specOf,
  statGeneric,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { stat as gridfsStat } from '../../../core/gridfs/stat.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

async function statCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return statGeneric(resolved, opts, (p) => gridfsStat(accessor, p, opts.index ?? undefined))
}

export const GRIDFS_STAT = command({
  name: 'stat',
  resource: ResourceName.GRIDFS,
  spec: specOf('stat'),
  fn: statCommand,
  provision: metadataProvision,
})
