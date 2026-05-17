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
import { findDocuments } from '../../../core/mongodb/_client.ts'
import { resolveGlob } from '../../../core/mongodb/glob.ts'
import { read as mongoRead } from '../../../core/mongodb/read.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { applyElision, elisionPaths, stringifyDoc } from '../../../core/mongodb/stream.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()

function headBytes(data: Uint8Array, lines: number, bytesMode: number | null): Uint8Array {
  if (bytesMode !== null) {
    return data.slice(0, bytesMode)
  }
  let count = 0
  let end = data.byteLength
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0x0a) {
      count += 1
      if (count >= lines) {
        end = i
        break
      }
    }
  }
  return data.slice(0, end)
}

async function headCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const cRaw = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const lines = nRaw !== null ? Number.parseInt(nRaw, 10) : 10
  const bytesMode = cRaw !== null ? Number.parseInt(cRaw, 10) : null

  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const scope = detectScope(first)

    if (
      scope.level === ScopeLevel.DOCUMENTS &&
      scope.database !== null &&
      scope.name !== null &&
      bytesMode === null
    ) {
      const limit = Math.min(lines, accessor.config.maxDocLimit)
      const docs = await findDocuments(
        accessor,
        scope.database,
        scope.name,
        {},
        { limit, sort: { _id: 1 } },
      )
      if (docs.length === 0) return [headBytes(new Uint8Array(0), lines, null), new IOResult()]
      const elide = elisionPaths(accessor, scope.database, scope.name)
      const jsonl =
        docs
          .map((d) => {
            const doc = d
            const final = elide.size > 0 ? applyElision(doc, elide) : doc
            return stringifyDoc(final)
          })
          .join('\n') + '\n'
      return [headBytes(ENC.encode(jsonl), lines, null), new IOResult()]
    }

    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const target = resolved[0]
    if (target === undefined) return [null, new IOResult()]
    const data = await mongoRead(accessor, target, opts.index ?? undefined)
    const out: ByteSource = headBytes(data, lines, bytesMode)
    return [out, new IOResult()]
  }

  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('head: missing operand\n') })]
  }
  return [headBytes(raw, lines, bytesMode), new IOResult()]
}

export const MONGODB_HEAD = command({
  name: 'head',
  resource: ResourceName.MONGODB,
  spec: specOf('head'),
  fn: headCommand,
  provision: fileReadProvision,
})
