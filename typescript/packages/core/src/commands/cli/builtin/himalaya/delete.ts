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

import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { deleteMessages, moveMessages } from '../../../../core/email/client.ts'
import { taggedFolder } from './deliver.ts'
import { rendered } from './printer.ts'

const TRASH_ATTRIBUTE = '\\trash'
const DEFAULT_TRASH_FOLDER = 'Trash'

export async function messageDelete(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const mailbox = fl.asStr('mailbox', 'INBOX')
  const trash =
    accessor.config.trashFolder ??
    (await taggedFolder(accessor, TRASH_ATTRIBUTE, DEFAULT_TRASH_FOLDER))
  let action: string
  let count: number
  let text: string
  if (mailbox !== trash) {
    count = await moveMessages(accessor, mailbox, trash, texts)
    action = 'moved-to-trash'
    text = `Successfully moved ${String(count)} message(s) to the trash`
  } else {
    count = texts.length
    if (await deleteMessages(accessor, mailbox, texts)) {
      action = 'deleted'
      text = `Successfully deleted ${String(count)} message(s) from the trash`
    } else {
      action = 'flagged'
      text = `Flagged ${String(count)} message(s) as deleted; run an expunge on the trash to remove them`
    }
  }
  return [rendered(fl, { action, count }, text), new IOResult()]
}
