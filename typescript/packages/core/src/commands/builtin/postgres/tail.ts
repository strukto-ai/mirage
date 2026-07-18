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
import { countRows } from '../../../core/postgres/_client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { POSTGRES_CMD_OPS } from './ops.ts'
import { readStream } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { tailGeneric } from '../generic/tail.ts'
import { parseN } from '../tail_helper.ts'
import { headTailProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(POSTGRES_CMD_OPS)

// Row reads on tables/views fetch only the last N rows (COUNT + OFFSET)
// instead of the whole relation; tailGeneric then trims the already-small
// chunk. Falls back to a full read for byte mode, +N mode, and non-row paths.
async function* tailSource(
  accessor: PostgresAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (pushdown && scope.level === 'entity_rows') {
    const limit = Math.min(lines, accessor.config.defaultRowLimit)
    const total = await countRows(accessor, scope.schema, scope.entity)
    const offset = Math.max(0, total - limit)
    yield* readStream(accessor, p, index, { limit, offset })
    return
  }
  yield* readStream(accessor, p, index)
}

async function tailCommand(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const [lines, plusMode] = parseN(nRaw)
  const pushdown = typeof opts.flags.c !== 'string' && !plusMode && lines > 0
  return tailGeneric(resolved, texts, opts, (p) =>
    tailSource(accessor, p, opts.index ?? undefined, lines, pushdown),
  )
}

export const POSTGRES_TAIL = command({
  name: 'tail',
  resource: ResourceName.POSTGRES,
  spec: specOf('tail'),
  fn: tailCommand,
  provision: headTailProvision,
})
