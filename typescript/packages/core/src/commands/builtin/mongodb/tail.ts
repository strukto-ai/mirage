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
import { documentsExist } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { readTail, watchStream } from '../../../core/mongodb/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
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

async function tailDocuments(
  accessor: MongoDBAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  n: number,
  notices: Uint8Array[],
): Promise<Uint8Array> {
  const [data, stopped] = await readTail(accessor, path, n, index)
  if (stopped)
    notices.push(
      rowCapNotice('tail', path.rawPath, accessor.config.maxDocLimit, 'documents', 'max_doc_limit'),
    )
  return data
}

async function watch(accessor: MongoDBAccessor, path: PathSpec): Promise<ByteSource | null> {
  if (!(await documentsExist(accessor, detectScope(path), path.virtual))) return null
  return watchStream(accessor, path)
}

export async function tail(
  ops: CommandIO<MongoDBAccessor>,
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(parsed) })]
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const first = resolved[0]
  if (
    parsed.following.follow &&
    resolved.length === 1 &&
    first !== undefined &&
    detectScope(first).kind === 'documents'
  ) {
    const stream = await guardOperation(watch, 'readBytes')(accessor, first)
    if (stream !== null) return [stream, new IOResult()]
  }
  const counts = parsed.counts
  const notices: Uint8Array[] = []
  const bounded = guardOperation(tailDocuments, 'readBytes')
  const read = (path: PathSpec): AsyncIterable<Uint8Array> => {
    const n = counts.lines ?? 10
    if (
      detectScope(path).kind === 'documents' &&
      counts.byteCount === null &&
      counts.fromByte === null &&
      n > 0 &&
      counts.fromLine === null &&
      !parsed.following.follow
    ) {
      return streamFromBytes(
        (a, p, i) => bounded(a, p, i, n, notices),
        accessor,
        path,
        opts.index ?? undefined,
      )
    }
    return ops.readStream(accessor, path, opts.index ?? undefined)
  }
  const result = await tailGeneric(resolved, texts, opts, read, (p) =>
    ops.stat(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  const [out, io] = result
  return [out === null ? out : noteAfter(out, io, notices), io]
}

export const BUILDER: Builder<MongoDBAccessor> = { name: 'tail', fn: tail, read: true }
