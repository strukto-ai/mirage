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

import type { NowledgeMemAccessor } from '../../../accessor/nowledge_mem.ts'
import { nowledgeMemPath, nowledgeMemRecall } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--in', valueKind: OperandKind.PATH }),
    new Option({ short: '-k', valueKind: OperandKind.TEXT }),
    new Option({ long: '--limit', valueKind: OperandKind.TEXT }),
  ],
  positional: [new Operand({ kind: OperandKind.TEXT })],
})

async function recallCommand(
  accessor: NowledgeMemAccessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = texts[0]
  if (query === undefined || query === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('recall: missing query\n') })]
  }
  const path =
    typeof opts.flags.in === 'string'
      ? nowledgeMemPath(opts.flags.in, opts.mountPrefix ?? '')
      : undefined
  const kText =
    typeof opts.flags.k === 'string'
      ? opts.flags.k
      : typeof opts.flags.limit === 'string'
        ? opts.flags.limit
        : undefined
  const parsedK = kText !== undefined ? Number.parseInt(kText, 10) : undefined
  const k = parsedK !== undefined && Number.isFinite(parsedK) ? parsedK : accessor.defaultLimit
  const results = await nowledgeMemRecall(accessor, query, {
    ...(path !== undefined ? { path } : {}),
    ...(k !== undefined ? { k } : {}),
  })
  const out: ByteSource = ENC.encode(results.join('\n'))
  return [out, new IOResult({ exitCode: results.length === 0 ? 1 : 0 })]
}

export const NOWLEDGE_MEM_RECALL = command({
  name: 'recall',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: SPEC,
  fn: recallCommand,
})
