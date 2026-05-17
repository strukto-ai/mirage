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
import { read as mongoRead } from '../../../core/mongodb/read.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()

async function wcCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const f = opts.flags
  const lFlag = f.args_l === true
  const wFlag = f.w === true
  const cFlag = f.c === true
  const mFlag = f.m === true
  const LFlag = f.L === true

  if (wFlag || mFlag || LFlag) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('wc: only -l and -c supported for MongoDB'),
      }),
    ]
  }

  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('wc: missing operand\n') })]
  }

  const first = paths[0]
  if (first === undefined) return [null, new IOResult()]
  const scope = detectScope(first)

  if (scope.level === ScopeLevel.DOCUMENTS && scope.database !== null && scope.name !== null) {
    if (cFlag) {
      const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
      const target = resolved[0]
      if (target === undefined) return [null, new IOResult()]
      const data = await mongoRead(accessor, target, opts.index ?? undefined)
      const out: ByteSource = ENC.encode(String(data.byteLength))
      return [out, new IOResult()]
    }
    if (lFlag) {
      const count = await countDocuments(accessor, scope.database, scope.name)
      return [ENC.encode(String(count)), new IOResult()]
    }
    const count = await countDocuments(accessor, scope.database, scope.name)
    return [ENC.encode(String(count)), new IOResult()]
  }

  return [
    null,
    new IOResult({
      exitCode: 1,
      stderr: ENC.encode('wc: path must target a collection file'),
    }),
  ]
}

export const MONGODB_WC = command({
  name: 'wc',
  resource: ResourceName.MONGODB,
  spec: specOf('wc'),
  fn: wcCommand,
  provision: fileReadProvision,
})
