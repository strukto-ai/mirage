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

import { IOResult } from '@struktoai/mirage-core'
import {
  ResourceName,
  command,
  duGeneric,
  duHasContent,
  duOperands,
  parseDuFlags,
  metadataProvision,
  resolveGlobOf,
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { size as gridfsDu, entries as gridfsDuAll } from '../../../core/gridfs/du/index.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

async function duCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const flags = parseDuFlags(opts)
  const idx = opts.index ?? undefined
  const { present, missing } = await duOperands(
    paths,
    opts.cwd,
    (targets) => resolveGlob(accessor, targets, idx),
    (p) => GRIDFS_IO.stat(accessor, p, idx),
    (p) =>
      duHasContent(
        (x) => gridfsDu(accessor, x),
        (x) => gridfsDuAll(accessor, x),
        p,
      ),
  )
  const out = await duGeneric(
    present,
    flags,
    (p) => gridfsDu(accessor, p),
    (p) => gridfsDuAll(accessor, p),
    missing,
  )
  return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
}

export const GRIDFS_DU = command({
  name: 'du',
  resource: ResourceName.GRIDFS,
  spec: specOf('du'),
  fn: duCommand,
  provision: metadataProvision,
})
