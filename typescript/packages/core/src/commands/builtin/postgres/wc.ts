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
import { resolveGlobOf, mountIo } from '../generic_bind/index.ts'
import { readStream } from '../../../core/postgres/read.ts'
import { entityExists } from '../../../core/postgres/readdir.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type PathSpec, VFSName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import {
  formatCountRows,
  parseFlags as parseWcFlags,
  wcGeneric,
  type WcRow,
} from '../generic/wc.ts'

const ENC = new TextEncoder()

function rowsScope(p: PathSpec): { schema: string; entity: string } | null {
  const scope = detectScope(p)
  if (scope.kind === 'entity_rows') {
    return { schema: scope.slots.schema ?? '', entity: scope.slots.entity ?? '' }
  }
  return null
}

// The count queries the relation by the names in the path, so the fast path
// runs only when every operand is an entity the mount can see; the generic
// stats the rest through the same guard and reports them.
async function allExist(accessor: PostgresAccessor, paths: readonly PathSpec[]): Promise<boolean> {
  for (const p of paths) {
    if (!(await entityExists(accessor, detectScope(p), p.virtual))) return false
  }
  return true
}

async function wc(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseWcFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const resolved =
    paths.length > 0
      ? await resolveGlobOf(mountIo(opts))(accessor, paths, opts.index ?? undefined)
      : []
  // Line counts on tables/views come from a server-side COUNT(*) instead of
  // reading every row. -l only (default prints words and bytes too, which
  // needs the content).
  const countOnly =
    parsed.lines && !parsed.words && !parsed.bytes && !parsed.chars && !parsed.maxLineLength
  if (
    countOnly &&
    resolved.length > 0 &&
    resolved.every((p) => rowsScope(p) !== null) &&
    (await allExist(accessor, resolved))
  ) {
    const rows: WcRow[] = []
    let total = 0
    for (const p of resolved) {
      const scope = rowsScope(p)
      if (scope === null) continue
      const count = await countRows(accessor, scope.schema, scope.entity)
      rows.push({ values: [count], label: p.rawPath })
      total += count
    }
    const out: ByteSource | null = formatCountRows(rows, [total], resolved.length, parsed.total)
    return [out, new IOResult({ countedRuns: rows })]
  }
  return wcGeneric(resolved, texts, opts, (p) => readStream(accessor, p, opts.index ?? undefined))
}

export const POSTGRES_WC = command({
  name: 'wc',
  vfs: VFSName.POSTGRES,
  spec: specOf('wc'),
  fn: wc,
})
