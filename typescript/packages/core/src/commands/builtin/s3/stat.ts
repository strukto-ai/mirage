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
import { S3_CMD_OPS } from './ops.ts'
import { stat as s3Stat } from '../../../core/s3/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { statGeneric } from '../generic/stat.ts'
import { metadataProvision } from '../generic_bind/provision.ts'

const resolveGlob = resolveGlobOf(S3_CMD_OPS)

async function statCommand(
  accessor: S3Accessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return statGeneric(resolved, opts, (p) => s3Stat(accessor, p, opts.index ?? undefined))
}

export const S3_STAT = command({
  name: 'stat',
  resource: ResourceName.S3,
  spec: specOf('stat'),
  fn: statCommand,
  provision: metadataProvision,
})
