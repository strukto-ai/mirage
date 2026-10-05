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

import type { AirtableAccessor } from '../../../accessor/airtable.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { read as airtableRead } from '../../../core/airtable/read.ts'
import { stat as airtableStat } from '../../../core/airtable/stat.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { IO } from './io.ts'

const resolveGlob = resolveGlobOf(IO)

// A record renders as exactly one line, so the first N lines of a records
// file are its first N records: the count rides maxRecords instead of paging
// the whole table. Files that are not record lists ignore the window.
async function* headSource(
  accessor: AirtableAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
): AsyncIterable<Uint8Array> {
  yield await airtableRead(accessor, p, index, pushdown ? { limit: lines } : {})
}

async function head(
  accessor: AirtableAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const fl = new FlagView(opts.flags, specOf('head'))
  const nRaw = fl.asStr('lines') ?? null
  const lines = nRaw !== null ? Number.parseInt(nRaw, 10) : 10
  const pushdown = fl.asStr('bytes') === undefined && !fl.asBool('zero_terminated') && lines > 0
  return headGeneric(
    resolved,
    texts,
    opts,
    (p) => airtableStat(accessor, p, opts.index ?? undefined),
    (p) => headSource(accessor, p, opts.index ?? undefined, lines, pushdown),
  )
}

export const AIRTABLE_HEAD = command({
  name: 'head',
  vfs: VFSName.AIRTABLE,
  spec: specOf('head'),
  fn: head,
})
