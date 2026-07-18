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

import type { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { POSTGRES_IO } from './io.ts'
import { readStream } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { stat as postgresStat } from '../../../core/postgres/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'
import { headTailProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(POSTGRES_IO)

// Row reads on tables/views push LIMIT into the query instead of fetching
// the whole relation; headGeneric then trims the already-small chunk. Falls
// back to a full read for byte mode and non-row paths.
async function* headSource(
  accessor: PostgresAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (pushdown && scope.level === 'entity_rows') {
    const limit = Math.min(lines, accessor.config.defaultRowLimit)
    yield* readStream(accessor, p, index, { limit, offset: 0 })
    return
  }
  yield* readStream(accessor, p, index)
}

async function headCommand(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const lines = nRaw !== null ? Number.parseInt(nRaw, 10) : 10
  const pushdown = typeof opts.flags.c !== 'string' && lines > 0
  return headGeneric(
    resolved,
    texts,
    opts,
    (p) => postgresStat(accessor, p, opts.index ?? undefined),
    (p) => headSource(accessor, p, opts.index ?? undefined, lines, pushdown),
  )
}

export const POSTGRES_HEAD = command({
  name: 'head',
  resource: ResourceName.POSTGRES,
  spec: specOf('head'),
  fn: headCommand,
  provision: headTailProvision,
})
