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
import { nowledgeMemFind, nowledgeMemPath } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ short: '-type', valueKind: OperandKind.TEXT }),
    new Option({ short: '-label', valueKind: OperandKind.TEXT }),
    new Option({ long: '--label', valueKind: OperandKind.TEXT }),
    new Option({ short: '-since', valueKind: OperandKind.TEXT }),
    new Option({ long: '--since', valueKind: OperandKind.TEXT }),
    new Option({ short: '-until', valueKind: OperandKind.TEXT }),
    new Option({ long: '--until', valueKind: OperandKind.TEXT }),
    new Option({ short: '-mentions', valueKind: OperandKind.TEXT }),
    new Option({ long: '--mentions', valueKind: OperandKind.TEXT }),
    new Option({ long: '--limit', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.PATH }),
})

function flagString(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[name]
    if (typeof value === 'string') return value
  }
  return undefined
}

async function findCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const p = paths[0]
  const path = p !== undefined ? nowledgeMemPath(p.original, p.prefix) : '/memories'
  const limitText = flagString(opts.flags, 'limit', '--limit')
  const parsedLimit = limitText !== undefined ? Number.parseInt(limitText, 10) : undefined
  const limit =
    parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : accessor.defaultLimit
  const type = flagString(opts.flags, 'type', '-type')
  const label = flagString(opts.flags, 'label', '-label', '--label')
  const since = flagString(opts.flags, 'since', '-since', '--since')
  const until = flagString(opts.flags, 'until', '-until', '--until')
  const mentions = flagString(opts.flags, 'mentions', '-mentions', '--mentions')
  const results = await nowledgeMemFind(accessor, path, {
    ...(type !== undefined ? { type } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  const out: ByteSource = ENC.encode(results.join('\n'))
  return [out, new IOResult()]
}

export const NOWLEDGE_MEM_FIND = command({
  name: 'find',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: SPEC,
  fn: findCommand,
})
