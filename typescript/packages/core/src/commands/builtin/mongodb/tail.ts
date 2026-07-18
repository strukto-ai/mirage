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
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { findDocuments } from '../../../core/mongodb/_client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { MONGODB_CMD_OPS } from './ops.ts'
import { streamAny } from '../../../core/mongodb/read.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import {
  applyElision,
  elisionPaths,
  stringifyDoc,
  watchStream,
} from '../../../core/mongodb/stream.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { tailGeneric } from '../generic/tail.ts'
import { parseN } from '../tail_helper.ts'
import { headTailProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(MONGODB_CMD_OPS)

const ENC = new TextEncoder()

// Fetches only the last N documents server-side (sort _id desc + limit)
// instead of streaming the whole collection; tailGeneric then trims the
// already-small chunk. Falls back to a full stream for byte mode, +N mode,
// and non-collection paths.
async function* tailSource(
  accessor: MongoDBAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (
    pushdown &&
    scope.level === ScopeLevel.DOCUMENTS &&
    scope.database !== null &&
    scope.name !== null
  ) {
    const limit = Math.min(lines, accessor.config.maxDocLimit)
    const docs = await findDocuments(
      accessor,
      scope.database,
      scope.name,
      {},
      { limit, sort: { _id: -1 } },
    )
    docs.reverse()
    if (docs.length === 0) return
    const elide = elisionPaths(accessor, scope.database, scope.name)
    const jsonl =
      docs.map((d) => stringifyDoc(elide.size > 0 ? applyElision(d, elide) : d)).join('\n') + '\n'
    yield ENC.encode(jsonl)
    return
  }
  yield* streamAny(accessor, p, index)
}

async function tailCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const first = resolved[0]
  if (
    opts.flags.f === true &&
    resolved.length === 1 &&
    first !== undefined &&
    detectScope(first).level === ScopeLevel.DOCUMENTS
  ) {
    return [watchStream(accessor, first), new IOResult()]
  }
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const [lines, plusMode] = parseN(nRaw)
  const pushdown = typeof opts.flags.c !== 'string' && !plusMode && lines > 0
  return tailGeneric(resolved, texts, opts, (p) =>
    tailSource(accessor, p, opts.index ?? undefined, lines, pushdown),
  )
}

export const MONGODB_TAIL = command({
  name: 'tail',
  resource: ResourceName.MONGODB,
  spec: specOf('tail'),
  fn: tailCommand,
  provision: headTailProvision,
})
