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
import { countRows } from '../../../core/postgres/client.ts'
import { resolveGlobOf, mountIo } from '../generic_bind/index.ts'
import { readStream } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { followFlags, tailGeneric } from '../generic/tail.ts'
import { parseN } from '../tail_counts.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { noteAfter, rowCapNotice } from '../utils/limit.ts'

// Row reads on tables/views fetch only the last N rows (COUNT + OFFSET)
// instead of the whole relation; tailGeneric then trims the already-small
// chunk. Falls back to a full read for byte mode, +N mode, and non-row paths.
// `maxReadRows` is the most rows one read may return; a suffix longer than
// that prints the ceiling and says so, where the ceiling (`defaultRowLimit`)
// used to stand in for the count with exit 0.
async function* tailSource(
  accessor: PostgresAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
  notices: Uint8Array[],
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (pushdown && scope.kind === 'entity_rows') {
    const cap = accessor.config.maxReadRows
    const total = await countRows(accessor, scope.slots.schema ?? '', scope.slots.entity ?? '')
    let limit = Math.min(lines, total)
    if (limit > cap) {
      limit = cap
      notices.push(rowCapNotice('tail', p.rawPath, cap, 'rows', 'max_read_rows'))
    }
    yield* readStream(accessor, p, index, { limit, offset: total - limit })
    return
  }
  yield* readStream(accessor, p, index)
}

async function tail(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0
      ? await resolveGlobOf(mountIo(opts))(accessor, paths, opts.index ?? undefined)
      : []
  const fl = new FlagView(opts.flags, specOf('tail'))
  const nRaw = fl.asStr('n') ?? null
  const [lines, plusMode] = parseN(nRaw)
  // A follow polls the file as it grows, and a pushed-down suffix moves
  // with the table, so it has no byte position to measure against: a
  // follow reads the relation whole.
  const following = followFlags(fl)
  const follow = typeof following !== 'string' && following.follow
  const pushdown = fl.asStr('c') === undefined && !plusMode && lines > 0 && !follow
  const notices: Uint8Array[] = []
  const result = await tailGeneric(
    resolved,
    texts,
    opts,
    (p) => tailSource(accessor, p, opts.index ?? undefined, lines, pushdown, notices),
    (p) => mountIo(opts).stat(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  const [out, io] = result
  if (out === null) return result
  return [noteAfter(out, io, notices), io]
}

export const POSTGRES_TAIL = command({
  name: 'tail',
  vfs: VFSName.POSTGRES,
  spec: specOf('tail'),
  fn: tail,
})
