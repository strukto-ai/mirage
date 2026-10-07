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
import { read as postgresRead } from '../../../core/postgres/read.ts'
import { entityExists } from '../../../core/postgres/readdir.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import type { PathSpec } from '../../../types.ts'
import { IOResult } from '../../../io/types.ts'
import { enoent } from '../../../errors/fs.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { tailGeneric, parseFlags } from '../generic/tail.ts'
import {
  type Builder,
  type CommandIO,
  guardOperation,
  resolveGlobOf,
} from '../generic_bind/adapter.ts'
import { noteAfter, rowCapNotice } from '../utils/limit.ts'
import { streamFromBytes } from '../utils/wrap.ts'

async function tailRows(
  accessor: PostgresAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  n: number,
  notices: Uint8Array[],
): Promise<Uint8Array> {
  const scope = detectScope(path)
  if (scope.kind !== 'entity_rows') return postgresRead(accessor, path, index)
  if (!(await entityExists(accessor, scope, path.virtual))) throw enoent(path.virtual)
  const schema = scope.slots.schema ?? '',
    entity = scope.slots.entity ?? ''
  const cap = accessor.config.maxReadRows
  const total = await countRows(accessor, schema, entity)
  const limit = Math.min(n, total, cap)
  if (Math.min(n, total) > cap)
    notices.push(rowCapNotice('tail', path.rawPath, cap, 'rows', 'max_read_rows'))
  return postgresRead(accessor, path, index, { limit, offset: total - limit })
}

export async function tail(
  ops: CommandIO<PostgresAccessor>,
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(parsed) })]
  const counts = parsed.counts
  const notices: Uint8Array[] = []
  const bounded = guardOperation(tailRows, 'readBytes')
  const n = counts.lines ?? 10
  const read =
    counts.byteCount === null &&
    counts.fromByte === null &&
    n > 0 &&
    counts.fromLine === null &&
    !parsed.following.follow
      ? (a: PostgresAccessor, p: PathSpec, i?: IndexCacheStore) => bounded(a, p, i, n, notices)
      : ops.readBytes
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const result = await tailGeneric(
    resolved,
    texts,
    opts,
    (p) => streamFromBytes(read, accessor, p, opts.index ?? undefined),
    (p) => ops.stat(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  const [out, io] = result
  return [out === null ? out : noteAfter(out, io, notices), io]
}

export const BUILDER: Builder<PostgresAccessor> = { name: 'tail', fn: tail, read: true }
