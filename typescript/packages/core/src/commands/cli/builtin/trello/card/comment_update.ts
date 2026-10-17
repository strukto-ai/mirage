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
import { commentUpdate as updateComment } from '../../../../../core/trello/client.ts'
import { normalizeComment } from '../../../../../core/trello/normalize.ts'
import { compactJsonBytes } from '../../../../../core/render/json.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { requireCard } from '../scope.ts'
import { requiredFlag, resolveTextInput } from '../util.ts'

export async function commentUpdate(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const cardId = requiredFlag(fl, 'card_id')
  const commentId = requiredFlag(fl, 'comment_id')
  const text = await resolveTextInput(ctx, fl, {
    value: 'text',
    file: 'text_file',
    errorMessage: 'comment text is required',
  })
  await requireCard(accessor, cardId)
  const updated = await updateComment(accessor.transport, cardId, commentId, text)
  return [compactJsonBytes(normalizeComment(updated, cardId)), new IOResult()]
}
