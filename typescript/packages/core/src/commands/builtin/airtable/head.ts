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
import { streamFromBytes } from '../utils/wrap.ts'

export async function head(
  ops: CommandIO<AirtableAccessor>,
  accessor: AirtableAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(parsed) })]
  // One record is one line; the bounded read pushes the limit into maxRecords.
  const bounded = guardOperation(airtableRead, 'readBytes')
  const read =
    parsed.bytesMode === null && parsed.lines > 0 && !parsed.zeroTerminated
      ? (a: AirtableAccessor, p: PathSpec, i?: IndexCacheStore) =>
          bounded(a, p, i, { limit: parsed.lines })
      : ops.readBytes
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  return headGeneric(
    resolved,
    texts,
    opts,
    (p) => ops.stat(accessor, p, opts.index ?? undefined),
    (p) => streamFromBytes(read, accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<AirtableAccessor> = { name: 'head', fn: head, read: true }
