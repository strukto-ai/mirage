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
import { read as postgresRead } from '../../../core/postgres/read.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import type { PathSpec } from '../../../types.ts'
import { IOResult } from '../../../io/types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { headGeneric, parseFlags } from '../generic/head.ts'
import {
  type Builder,
  type CommandIO,
  guardOperation,
  resolveGlobOf,
} from '../generic_bind/adapter.ts'
import { noteAfter, rowCapNotice } from '../utils/limit.ts'
import { streamFromBytes } from '../utils/wrap.ts'

async function headRows(
  accessor: PostgresAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  n: number,
  notices: Uint8Array[],
): Promise<Uint8Array> {
  const cap = accessor.config.maxReadRows
  if (n <= cap || detectScope(path).kind !== 'entity_rows') {
    return postgresRead(accessor, path, index, { limit: n })
  }
  const data = await postgresRead(accessor, path, index, { limit: cap + 1 })
  let seen = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x0a) continue
    seen += 1
    if (seen === cap && i + 1 < data.length) {
      notices.push(rowCapNotice('head', path.rawPath, cap, 'rows', 'max_read_rows'))
      return data.subarray(0, i + 1)
    }
  }
  return data
}

export async function head(
  ops: CommandIO<PostgresAccessor>,
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(parsed) })]
  const notices: Uint8Array[] = []
  const bounded = guardOperation(headRows, 'readBytes')
  const read =
    parsed.bytesMode === null && parsed.lines > 0 && !parsed.zeroTerminated
      ? (a: PostgresAccessor, p: PathSpec, i?: IndexCacheStore) =>
          bounded(a, p, i, parsed.lines, notices)
      : ops.readBytes
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const result = await headGeneric(
    resolved,
    texts,
    opts,
    (p) => ops.stat(accessor, p, opts.index ?? undefined),
    (p) => streamFromBytes(read, accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  const [out, io] = result
  return [out === null ? out : noteAfter(out, io, notices), io]
}

export const BUILDER: Builder<PostgresAccessor> = { name: 'head', fn: head, read: true }
