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
import { countDocuments } from '../../../core/mongodb/client.ts'
import { documentsExist } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatCountRows, parseFlags, wcGeneric, type WcRow } from '../generic/wc.ts'
import {
  type Builder,
  type CommandIO,
  guardOperation,
  resolveGlobOf,
} from '../generic_bind/adapter.ts'

async function count(accessor: MongoDBAccessor, path: PathSpec): Promise<number | null> {
  const scope = detectScope(path)
  if (!(await documentsExist(accessor, scope, path.virtual))) return null
  return countDocuments(accessor, scope.slots.database ?? '', scope.slots.name ?? '')
}

export async function wc(
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
  const countOnly =
    parsed.lines && !parsed.words && !parsed.bytes && !parsed.chars && !parsed.maxLineLength
  if (
    countOnly &&
    resolved.length > 0 &&
    resolved.every((p) => detectScope(p).kind === 'documents')
  ) {
    const rows: WcRow[] = []
    let total = 0
    let stderr = ''
    let complete = true
    const counted = guardOperation(count, 'readBytes')
    for (const p of resolved) {
      let n: number | null
      try {
        n = await counted(accessor, p)
      } catch (error) {
        if (!isFsError(error)) throw error
        stderr += fsErrorLine('wc', p, error)
        continue
      }
      if (n === null) {
        complete = false
        break
      }
      rows.push({ values: [n], label: p.rawPath })
      total += n
    }
    if (complete) {
      return [
        formatCountRows(rows, [total], resolved.length, parsed.total),
        new IOResult({
          exitCode: stderr ? 1 : 0,
          stderr: new TextEncoder().encode(stderr),
          countedRuns: rows,
        }),
      ]
    }
  }
  return wcGeneric(resolved, texts, opts, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<MongoDBAccessor> = { name: 'wc', fn: wc, read: true }
