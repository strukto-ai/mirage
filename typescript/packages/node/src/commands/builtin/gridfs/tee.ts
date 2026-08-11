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
  teeGeneric,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { stream as gridfsStream } from '../../../core/gridfs/stream.ts'
import { write as gridfsWrite } from '../../../core/gridfs/write.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

async function teeCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tee: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  // Wiring only: every flag semantic, the write to each operand and the append
  // fallback live in the generic. This file used to restate them, wrote only
  // resolved[0], and carried an exists() pre-check to work around the
  // generic's broken not-found test.
  return teeGeneric(
    resolved,
    texts,
    opts,
    (p) => gridfsStream(accessor, p),
    (p, d) => gridfsWrite(accessor, p, d),
  )
}

export const GRIDFS_TEE = command({
  name: 'tee',
  resource: ResourceName.GRIDFS,
  spec: specOf('tee'),
  fn: teeCommand,
  write: true,
})
