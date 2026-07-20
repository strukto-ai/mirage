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
import { cardCreate } from '../../../core/trello/_client.ts'
import { normalizeCard } from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'
import { resolveTextInput } from './_input.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--list_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--name', valueKind: OperandKind.TEXT }),
    new Option({ long: '--desc', valueKind: OperandKind.TEXT }),
    new Option({ long: '--desc_file', valueKind: OperandKind.PATH }),
  ],
})

async function trelloCardCreateCommand(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const listId = opts.flags.list_id
  if (typeof listId !== 'string' || listId === '') {
    throw new Error('--list_id is required')
  }
  const name = opts.flags.name
  if (typeof name !== 'string' || name === '') {
    throw new Error('--name is required')
  }
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
  const card = await cardCreate(accessor.transport, {
    listId,
    name,
    ...(desc !== undefined ? { desc } : {}),
  })
  return [ENC.encode(JSON.stringify(normalizeCard(card))), new IOResult()]
}

export const TRELLO_CARD_CREATE = command({
  name: 'trello card create',
  resource: ResourceName.TRELLO,
  spec: SPEC,
  fn: trelloCardCreateCommand,
  write: true,
})
