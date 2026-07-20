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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import { cardUpdate } from '../../../core/trello/_client.ts'
import { normalizeCard } from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'
import { resolveTextInput } from './_input.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--card_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--name', valueKind: OperandKind.TEXT }),
    new Option({ long: '--desc', valueKind: OperandKind.TEXT }),
    new Option({ long: '--desc_file', valueKind: OperandKind.PATH }),
    new Option({ long: '--due', valueKind: OperandKind.TEXT }),
    new Option({ long: '--closed', valueKind: OperandKind.TEXT }),
  ],
})

function parseBool(value: string): boolean {
  const v = value.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

async function trelloCardUpdateCommand(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const cardId = opts.flags.card_id
  if (typeof cardId !== 'string' || cardId === '') {
    throw new Error('--card_id is required')
  }
  const name = typeof opts.flags.name === 'string' ? opts.flags.name : null
  const inlineDesc = typeof opts.flags.desc === 'string' ? opts.flags.desc : null
  const descFile = typeof opts.flags.desc_file === 'string' ? opts.flags.desc_file : null
  let desc: string | undefined
  if (inlineDesc !== null || descFile !== null || opts.stdin !== null) {
    desc = await resolveTextInput(accessor.transport, {
      inlineText: inlineDesc,
      filePath: descFile,
      stdin: opts.stdin,
      errorMessage: 'desc is required',
    })
  }
  const closed = typeof opts.flags.closed === 'string' ? parseBool(opts.flags.closed) : null
  const due = typeof opts.flags.due === 'string' ? opts.flags.due : null
  const card = await cardUpdate(accessor.transport, {
    cardId,
    ...(name !== null ? { name } : {}),
    ...(desc !== undefined ? { desc } : {}),
    ...(closed !== null ? { closed } : {}),
    ...(due !== null ? { due } : {}),
  })
  return [ENC.encode(JSON.stringify(normalizeCard(card))), new IOResult()]
}

export const TRELLO_CARD_UPDATE = command({
  name: 'trello card update',
  resource: ResourceName.TRELLO,
  spec: SPEC,
  fn: trelloCardUpdateCommand,
  write: true,
})
