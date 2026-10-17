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

import type { TrelloAccessor } from '../../../../../accessor/trello.ts'
import { cardUpdate } from '../../../../../core/trello/client.ts'
import { normalizeCard } from '../../../../../core/trello/normalize.ts'
import { compactJsonBytes } from '../../../../../core/render/json.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { requireCard } from '../scope.ts'
import { fileOperand, requiredFlag, resolveTextInput } from '../util.ts'

function parseBool(value: string): boolean {
  const v = value.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export async function update(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const cardId = requiredFlag(fl, 'card_id')
  const name = fl.asStr('name') ?? null
  let desc: string | undefined
  if (
    fl.asStr('desc') !== undefined ||
    fileOperand(fl, 'desc_file') !== null ||
    ctx.stdin !== null
  ) {
    desc = await resolveTextInput(ctx, fl, {
      value: 'desc',
      file: 'desc_file',
      errorMessage: 'desc is required',
    })
  }
  const closedFlag = fl.asStr('closed')
  const closed = closedFlag === undefined ? null : parseBool(closedFlag)
  const due = fl.asStr('due') ?? null
  await requireCard(accessor, cardId)
  const card = await cardUpdate(accessor.transport, {
    cardId,
    ...(name !== null ? { name } : {}),
    ...(desc !== undefined ? { desc } : {}),
    ...(closed !== null ? { closed } : {}),
    ...(due !== null ? { due } : {}),
  })
  return [compactJsonBytes(normalizeCard(card)), new IOResult()]
}
