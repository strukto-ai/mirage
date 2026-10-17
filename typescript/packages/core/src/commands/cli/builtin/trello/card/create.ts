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
import { cardCreate } from '../../../../../core/trello/client.ts'
import { normalizeCard } from '../../../../../core/trello/normalize.ts'
import { compactJsonBytes } from '../../../../../core/render/json.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { requireList } from '../scope.ts'
import { fileOperand, requiredFlag, resolveTextInput } from '../util.ts'

export async function create(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const listId = requiredFlag(fl, 'list_id')
  const name = requiredFlag(fl, 'name')
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
  await requireList(accessor, listId)
  const card = await cardCreate(accessor.transport, {
    listId,
    name,
    ...(desc !== undefined ? { desc } : {}),
  })
  return [compactJsonBytes(normalizeCard(card)), new IOResult()]
}
