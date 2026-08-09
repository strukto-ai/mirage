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
import { cardRemoveLabel } from '../../../core/trello/_client.ts'
import { normalizeCard } from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'
import { FlagView } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--card_id', type: 'str' }),
    new Option({ long: '--label_id', type: 'str' }),
  ],
})

async function trelloCardLabelRemoveCommand(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, SPEC)
  const cardId = fl.asStr('card_id')
  if (cardId === undefined || cardId === '') throw new Error('--card_id is required')
  const labelId = fl.asStr('label_id')
  if (labelId === undefined || labelId === '') throw new Error('--label_id is required')
  const card = await cardRemoveLabel(accessor.transport, cardId, labelId)
  return [ENC.encode(JSON.stringify(normalizeCard(card))), new IOResult()]
}

export const TRELLO_CARD_LABEL_REMOVE = command({
  name: 'trello card unlabel',
  resource: ResourceName.TRELLO,
  spec: SPEC,
  fn: trelloCardLabelRemoveCommand,
  write: true,
})
