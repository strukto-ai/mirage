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
import { requireMountWritable } from '../../../context/session_context.ts'
import { commentUpdate } from '../../../core/trello/client.ts'
import { normalizeComment } from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Argument } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { resolveTextInput } from './_input.ts'
import { requireCard } from './_scope.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  arguments: [
    new Argument('--card_id'),
    new Argument('--comment_id'),
    new Argument('--text'),
    new Argument('--text_file', { type: 'path' }),
  ],
})

async function trelloCardCommentUpdate(
  accessor: TrelloAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, SPEC)
  const cardId = fl.asStr('card_id')
  if (cardId === undefined || cardId === '') throw new Error('--card_id is required')
  const commentId = fl.asStr('comment_id')
  if (commentId === undefined || commentId === '') {
    throw new Error('--comment_id is required')
  }
  const inlineText = fl.asStr('text') ?? null
  const textFile = fl.asPath('text_file') ?? null
  const text = await resolveTextInput(accessor, {
    inlineText,
    filePath: textFile,
    stdin: opts.stdin,
    errorMessage: 'comment text is required',
  })
  // A card write is addressed by id, not path, so only the mount-wide
  // grant can admit it (a write-granting carve-out names no card).
  requireMountWritable(opts.mountPrefix ?? '')
  await requireCard(accessor, cardId)
  const comment = await commentUpdate(accessor.transport, cardId, commentId, text)
  return [ENC.encode(JSON.stringify(normalizeComment(comment, cardId))), new IOResult()]
}

export const TRELLO_CARD_COMMENT_UPDATE = command({
  name: 'trello card comment-update',
  vfs: VFSName.TRELLO,
  spec: SPEC,
  fn: trelloCardCommentUpdate,
  write: true,
})
