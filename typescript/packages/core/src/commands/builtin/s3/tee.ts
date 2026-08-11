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
import { resolveGlobOf } from '../generic_bind/index.ts'
import { teeGeneric } from '../generic/tee.ts'
import { S3_IO } from './io.ts'
import { stream as s3Stream } from '../../../core/s3/stream.ts'
import { write as s3Write } from '../../../core/s3/write.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const resolveGlob = resolveGlobOf(S3_IO)

const ENC = new TextEncoder()

async function teeCommand(
  accessor: S3Accessor,
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
    (p) => s3Stream(accessor, p),
    (p, d) => s3Write(accessor, p, d),
  )
}

export const S3_TEE = command({
  name: 'tee',
  resource: ResourceName.S3,
  spec: specOf('tee'),
  fn: teeCommand,
  write: true,
})
