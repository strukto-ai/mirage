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

import type { S3Accessor } from '../../../accessor/s3.ts'
import { exists as s3Exists } from '../../../core/s3/exists.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { S3_IO } from './io.ts'
import { write as s3Write } from '../../../core/s3/write.ts'
import { IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { writeMetadataProvision } from '../generic_bind/provision.ts'

const resolveGlob = resolveGlobOf(S3_IO)

const ENC = new TextEncoder()

async function touchCommand(
  accessor: S3Accessor,
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
    if (!(await s3Exists(accessor, p))) {
      await s3Write(accessor, p, new Uint8Array(0))
      writes[p.mountPath] = new Uint8Array()
    }
  }
  return [null, new IOResult({ writes })]
}

export const S3_TOUCH = command({
  name: 'touch',
  resource: ResourceName.S3,
  spec: specOf('touch'),
  fn: touchCommand,
  write: true,
  provision: writeMetadataProvision,
})
