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
import { countDocuments, findDocuments } from '../../../core/mongodb/client.ts'
import { resolveGlobOf, mountIo } from '../generic_bind/index.ts'
import { streamAny } from '../../../core/mongodb/read.ts'
import { documentsExist, entityGuard } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import {
  applyElision,
  elisionPaths,
  stringifyDoc,
  watchStream,
} from '../../../core/mongodb/stream.ts'
import { IOResult } from '../../../io/types.ts'
import { type PathSpec, VFSName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { followFlags, tailGeneric } from '../generic/tail.ts'
import { parseN } from '../tail_counts.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { noteAfter, rowCapNotice } from '../utils/limit.ts'

const ENC = new TextEncoder()

// Fetches only the last N documents server-side (sort _id desc + limit)
// instead of streaming the whole collection; tailGeneric then trims the
// already-small chunk. Falls back to a full stream for byte mode, +N mode,
// and non-collection paths.
// `maxDocLimit` is the most documents one read may return; a count past it
// that the collection could fill prints the last `maxDocLimit` and says so,
// where the ceiling used to stand in for the count in silence.
async function* tailSource(
  accessor: MongoDBAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
  lines: number,
  pushdown: boolean,
  notices: Uint8Array[],
): AsyncIterable<Uint8Array> {
  const scope = detectScope(p)
  if (pushdown && scope.kind === 'documents') {
    await entityGuard(accessor, scope, p.virtual)
    const cap = accessor.config.maxDocLimit
    const limit = Math.min(lines, cap)
    if (
      lines > cap &&
      (await countDocuments(accessor, scope.slots.database ?? '', scope.slots.name ?? '')) > cap
    ) {
      notices.push(rowCapNotice('tail', p.rawPath, cap, 'documents', 'max_doc_limit'))
    }
    const docs = await findDocuments(
      accessor,
      scope.slots.database ?? '',
      scope.slots.name ?? '',
      {},
      { limit, sort: { _id: -1 } },
    )
    docs.reverse()
    if (docs.length === 0) return
    const elide = elisionPaths(accessor, scope.slots.database ?? '', scope.slots.name ?? '')
    const jsonl =
      docs.map((d) => stringifyDoc(elide.size > 0 ? applyElision(d, elide) : d)).join('\n') + '\n'
    yield ENC.encode(jsonl)
    return
  }
  yield* streamAny(accessor, p, index)
}

async function tail(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tail'))
  const resolved =
    paths.length > 0
      ? await resolveGlobOf(mountIo(opts))(accessor, paths, opts.index ?? undefined)
      : []
  const first = resolved[0]
  // One followed collection is a change stream (-F included, as the
  // Python twin reads it); anything else a follow polls, and a
  // pushed-down suffix moves with the collection, so it has no byte
  // position to measure against: a follow reads the collection whole.
  const following = followFlags(fl)
  const follow = typeof following !== 'string' && following.follow
  // The change stream queries the collection by the names in the path, so it
  // runs only for one the mount can see; anything else takes the generic,
  // which stats it through the same guard and reports it.
  if (
    follow &&
    resolved.length === 1 &&
    first !== undefined &&
    detectScope(first).kind === 'documents' &&
    (await documentsExist(accessor, detectScope(first), first.virtual))
  ) {
    return [watchStream(accessor, first), new IOResult()]
  }
  const nRaw = fl.asStr('n') ?? null
  const [lines, plusMode] = parseN(nRaw)
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

export const MONGODB_TAIL = command({
  name: 'tail',
  vfs: VFSName.MONGODB,
  spec: specOf('tail'),
  fn: tail,
})
