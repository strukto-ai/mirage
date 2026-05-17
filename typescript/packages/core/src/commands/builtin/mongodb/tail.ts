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
import { parseN, tailBytes } from '../tail_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()

function tailResult(
  raw: Uint8Array,
  lines: number,
  plusMode: boolean,
  bytesMode: number | null,
): Uint8Array {
  if (bytesMode !== null) {
    return bytesMode === 0 ? new Uint8Array(0) : raw.slice(-bytesMode)
  }
  return tailBytes(raw, lines, null, plusMode)
}

async function tailCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const nRaw = typeof opts.flags.n === 'string' ? opts.flags.n : null
  const cRaw = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const [lines, plusMode] = parseN(nRaw)
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
        { limit, sort: { _id: -1 } },
      )
      docs.reverse()
      if (docs.length === 0) {
        return [tailResult(new Uint8Array(0), lines, plusMode, null), new IOResult()]
      }
      const elide = elisionPaths(accessor, scope.database, scope.name)
      const jsonl =
        docs
          .map((d) => {
            const doc = d
            const final = elide.size > 0 ? applyElision(doc, elide) : doc
            return stringifyDoc(final)
          })
          .join('\n') + '\n'
      return [tailResult(ENC.encode(jsonl), lines, plusMode, null), new IOResult()]
    }

    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const target = resolved[0]
    if (target === undefined) return [null, new IOResult()]
    const raw = await mongoRead(accessor, target, opts.index ?? undefined)
    const out: ByteSource = tailResult(raw, lines, plusMode, bytesMode)
    return [out, new IOResult()]
  }

  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tail: missing operand\n') })]
  }
  return [tailResult(raw, lines, plusMode, bytesMode), new IOResult()]
}

export const MONGODB_TAIL = command({
  name: 'tail',
  resource: ResourceName.MONGODB,
  spec: specOf('tail'),
  fn: tailCommand,
  provision: fileReadProvision,
})
