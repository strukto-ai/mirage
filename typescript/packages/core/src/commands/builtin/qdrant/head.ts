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

import type { QdrantAccessor } from '../../../accessor/qdrant.ts'
import { resolveGlob } from '../../../core/qdrant/glob.ts'
import { stat as qdrantStat } from '../../../core/qdrant/stat.ts'
import { stream as qdrantStream } from '../../../core/qdrant/stream.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'

async function headCommand(
  accessor: QdrantAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return headGeneric(
    resolved,
    texts,
    opts,
    (p) => qdrantStat(accessor, p, opts.index ?? undefined),
    (p) => qdrantStream(accessor, p, opts.index ?? undefined),
  )
}

export const QDRANT_HEAD = command({
  name: 'head',
  resource: ResourceName.QDRANT,
  spec: specOf('head'),
  fn: headCommand,
})
