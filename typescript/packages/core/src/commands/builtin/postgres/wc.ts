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
import { countRows } from '../../../core/postgres/_client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { POSTGRES_CMD_OPS } from './ops.ts'
import { readStream } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { formatRecords } from '../utils/output.ts'
import { formatWcLines, wcGeneric, type WcRow } from '../generic/wc.ts'
import { fileReadProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(POSTGRES_CMD_OPS)

function rowsScope(p: PathSpec): { schema: string; entity: string } | null {
  const scope = detectScope(p)
  if (scope.level === 'entity_rows') {
    return { schema: scope.schema, entity: scope.entity }
  }
  return null
}

async function wcCommand(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const f = opts.flags
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  // Line counts on tables/views come from a server-side COUNT(*) instead of
  // reading every row. -l only (default prints words and bytes too, which
  // needs the content).
  const countOnly =
    f.args_l === true && f.w !== true && f.c !== true && f.m !== true && f.L !== true
  if (countOnly && resolved.length > 0 && resolved.every((p) => rowsScope(p) !== null)) {
    const rows: WcRow[] = []
    let total = 0
    for (const p of resolved) {
      const scope = rowsScope(p)
      if (scope === null) continue
      const count = await countRows(accessor, scope.schema, scope.entity)
      rows.push({ values: [count], label: p.virtual })
      total += count
    }
    if (resolved.length > 1) rows.push({ values: [total], label: 'total' })
    const out: ByteSource = formatRecords(formatWcLines(rows))
    return [out, new IOResult()]
  }
  return wcGeneric(resolved, texts, opts, (p) => readStream(accessor, p, opts.index ?? undefined))
}

export const POSTGRES_WC = command({
  name: 'wc',
  resource: ResourceName.POSTGRES,
  spec: specOf('wc'),
  fn: wcCommand,
  provision: fileReadProvision,
})
