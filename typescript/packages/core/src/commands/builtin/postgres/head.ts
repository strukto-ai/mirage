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
import { IO } from './io.ts'
import { read, readStream } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import { stat as postgresStat } from '../../../core/postgres/stat.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { noteAfter, rowCapNotice } from '../utils/limit.ts'

const resolveGlob = resolveGlobOf(IO)

const NL = 0x0a

// Row reads on tables/views push LIMIT into the query instead of fetching
// the whole relation; headGeneric then trims the already-small chunk. Falls
// back to a full read for byte mode and non-row paths. `maxReadRows` is the
// most rows one read may return, so a count past it fetches one row more than
// the ceiling: when that row exists the output stops at the ceiling and a
// notice says so, rather than the ceiling (`defaultRowLimit` it was, too)
// standing in for the count with exit 0. Mirrors `_head_rows` in
// `commands/builtin/postgres/head.py`.
async function* headSource(
  accessor: PostgresAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
  notices: Uint8Array[],
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (!pushdown || scope.kind !== 'entity_rows') {
    yield* readStream(accessor, p, index)
    return
  }
  const cap = accessor.config.maxReadRows
  if (lines <= cap) {
    yield* readStream(accessor, p, index, { limit: lines, offset: 0 })
    return
  }
  const data = await read(accessor, p, index, { limit: cap + 1, offset: 0 })
  let seen = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== NL) continue
    seen += 1
    if (seen === cap && i + 1 < data.length) {
      notices.push(rowCapNotice('head', p.rawPath, cap, 'rows', 'max_read_rows'))
      yield data.subarray(0, i + 1)
      return
    }
  }
  yield data
}

async function head(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const fl = new FlagView(opts.flags, specOf('head'))
  const nRaw = fl.asStr('lines') ?? null
  const lines = nRaw !== null ? Number.parseInt(nRaw, 10) : 10
  const pushdown = fl.asStr('bytes') === undefined && lines > 0 && !fl.asBool('zero_terminated')
  const notices: Uint8Array[] = []
  const result = await headGeneric(
    resolved,
    texts,
    opts,
    (p) => postgresStat(accessor, p, opts.index ?? undefined),
    (p) => headSource(accessor, p, opts.index ?? undefined, lines, pushdown, notices),
  )
  if (result === null) return result
  const [out, io] = result
  if (out === null) return result
  return [noteAfter(out, io, notices), io]
}

export const POSTGRES_HEAD = command({
  name: 'head',
  vfs: VFSName.POSTGRES,
  spec: specOf('head'),
  fn: head,
})
