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
import { cardAddLabel } from '../../../core/trello/_client.ts'
import { normalizeCard } from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--card_id', valueKind: OperandKind.TEXT }),
    new Option({ long: '--label_id', valueKind: OperandKind.TEXT }),
  ],
})

async function trelloCardLabelAddCommand(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const cardId = opts.flags.card_id
  if (typeof cardId !== 'string' || cardId === '') throw new Error('--card_id is required')
  const labelId = opts.flags.label_id
  if (typeof labelId !== 'string' || labelId === '') throw new Error('--label_id is required')
  const card = await cardAddLabel(accessor.transport, cardId, labelId)
  return [ENC.encode(JSON.stringify(normalizeCard(card))), new IOResult()]
}

export const TRELLO_CARD_LABEL_ADD = command({
  name: 'trello card label',
  resource: ResourceName.TRELLO,
  spec: SPEC,
  fn: trelloCardLabelAddCommand,
  write: true,
})
