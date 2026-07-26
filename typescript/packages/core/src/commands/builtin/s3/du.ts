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
import { size as s3Du, entries as s3DuAll } from '../../../core/s3/du/index.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { S3_IO } from './io.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { IOResult } from '../../../io/types.ts'
import { duGeneric, duHasContent, duOperands, parseDuFlags } from '../generic/du.ts'
import { metadataProvision } from '../generic_bind/provision.ts'

const resolveGlob = resolveGlobOf(S3_IO)

async function duCommand(
  accessor: S3Accessor,
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
    (p) => S3_IO.stat(accessor, p, idx),
    (p) =>
      duHasContent(
        (x) => s3Du(accessor, x, idx),
        (x) => s3DuAll(accessor, x, idx),
        p,
      ),
  )
  const out = await duGeneric(
    present,
    flags,
    (p) => s3Du(accessor, p, idx),
    (p) => s3DuAll(accessor, p, idx),
    missing,
  )
  return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
}

export const S3_DU = command({
  name: 'du',
  resource: ResourceName.S3,
  spec: specOf('du'),
  fn: duCommand,
  provision: metadataProvision,
})
