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
import { countRows } from '../../../core/postgres/client.ts'
import { entityExists } from '../../../core/postgres/readdir.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatCountRows, parseFlags, wcGeneric, type WcRow } from '../generic/wc.ts'
import {
  type Builder,
  type CommandIO,
  guardOperation,
  resolveGlobOf,
} from '../generic_bind/adapter.ts'

async function count(accessor: PostgresAccessor, path: PathSpec): Promise<number | null> {
  const scope = detectScope(path)
  if (!(await entityExists(accessor, scope, path.virtual))) return null
  return countRows(accessor, scope.slots.schema ?? '', scope.slots.entity ?? '')
}

export async function wc(
  ops: CommandIO<PostgresAccessor>,
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(parsed) })]
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const countOnly =
    parsed.lines && !parsed.words && !parsed.bytes && !parsed.chars && !parsed.maxLineLength
  if (
    countOnly &&
    resolved.length > 0 &&
    resolved.every((p) => detectScope(p).kind === 'entity_rows')
  ) {
    const rows: WcRow[] = []
    let total = 0
    const counted = guardOperation(count, 'readBytes')
    for (const p of resolved) {
      const n = await counted(accessor, p)
      if (n === null) break
      rows.push({ values: [n], label: p.rawPath })
      total += n
    }
    if (rows.length === resolved.length) {
      return [
        formatCountRows(rows, [total], resolved.length, parsed.total),
        new IOResult({ countedRuns: rows }),
      ]
    }
  }
  return wcGeneric(resolved, texts, opts, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<PostgresAccessor> = { name: 'wc', fn: wc, read: true }
