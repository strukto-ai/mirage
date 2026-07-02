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
import { countDocuments } from '../../../core/mongodb/_client.ts'
import { resolveGlob } from '../../../core/mongodb/glob.ts'
import { streamAny } from '../../../core/mongodb/read.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { formatRecords } from '../utils/output.ts'
import { formatWcLines, wcGeneric, type WcRow } from '../generic/wc.ts'
import { fileReadProvision } from './_provision.ts'

function documentsScope(p: PathSpec): { database: string; name: string } | null {
  const scope = detectScope(p)
  if (scope.level === ScopeLevel.DOCUMENTS && scope.database !== null && scope.name !== null) {
    return { database: scope.database, name: scope.name }
  }
  return null
}

async function wcCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const f = opts.flags
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  // Line counts on collections come from a server-side countDocuments
  // instead of reading every document. -l only (default prints words and
  // bytes too, which needs the content).
  const countOnly =
    f.args_l === true && f.w !== true && f.c !== true && f.m !== true && f.L !== true
  if (countOnly && resolved.length > 0 && resolved.every((p) => documentsScope(p) !== null)) {
    const rows: WcRow[] = []
    let total = 0
    for (const p of resolved) {
      const scope = documentsScope(p)
      if (scope === null) continue
      const count = await countDocuments(accessor, scope.database, scope.name)
      rows.push({ values: [count], label: p.virtual })
      total += count
    }
    if (resolved.length > 1) rows.push({ values: [total], label: 'total' })
    const out: ByteSource = formatRecords(formatWcLines(rows))
    return [out, new IOResult()]
  }
  return wcGeneric(resolved, texts, opts, (p) => streamAny(accessor, p, opts.index ?? undefined))
}

export const MONGODB_WC = command({
  name: 'wc',
  resource: ResourceName.MONGODB,
  spec: specOf('wc'),
  fn: wcCommand,
  provision: fileReadProvision,
})
