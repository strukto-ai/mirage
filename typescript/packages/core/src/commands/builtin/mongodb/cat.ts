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

import type { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { MONGODB_CMD_OPS } from './ops.ts'
import { streamAny } from '../../../core/mongodb/read.ts'
import { stat as mongoStat } from '../../../core/mongodb/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { catGeneric } from '../generic/cat.ts'
import { fileReadProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(MONGODB_CMD_OPS)

async function catCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return catGeneric(
    resolved,
    texts,
    opts,
    (p) => mongoStat(accessor, p, opts.index ?? undefined),
    (p) => streamAny(accessor, p, opts.index ?? undefined),
  )
}

export const MONGODB_CAT = command({
  name: 'cat',
  resource: ResourceName.MONGODB,
  spec: specOf('cat'),
  fn: catCommand,
  provision: fileReadProvision,
})
