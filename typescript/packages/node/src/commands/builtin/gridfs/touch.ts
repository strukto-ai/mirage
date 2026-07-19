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
  resolveGlobOf,
  specOf,
  writeMetadataProvision,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { exists as gridfsExists } from '../../../core/gridfs/exists.ts'
import { write as gridfsWrite } from '../../../core/gridfs/write.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

async function touchCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('touch: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const createOnly = opts.flags.c === true
  const writes: Record<string, Uint8Array> = {}
  for (const p of resolved) {
    if (createOnly) continue
    if (!(await gridfsExists(accessor, p))) {
      await gridfsWrite(accessor, p, new Uint8Array(0))
      writes[p.mountPath] = new Uint8Array()
    }
  }
  return [null, new IOResult({ writes })]
}

export const GRIDFS_TOUCH = command({
  name: 'touch',
  resource: ResourceName.GRIDFS,
  spec: specOf('touch'),
  fn: touchCommand,
  write: true,
  provision: writeMetadataProvision,
})
