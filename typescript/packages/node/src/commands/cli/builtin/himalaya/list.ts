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

import type { CommandFnResult, Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import { IOResult } from '@struktoai/mirage-core/io/types'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchHeaders, listMessageUids } from '../../../../core/email/client.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { envelopesJsonBytes } from '../../../../core/email/render.ts'
import { pageSlice, pageWindow, sortHeaders, uidBudget } from './query.ts'

export const DEFAULT_PAGE_SIZE = 25

export async function listEnvelopes(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const mailbox = fl.asStr('mailbox', 'INBOX')
  const account = config as EmailConfig
  const [page, pageSize] = pageWindow(
    fl.asInt('page', 1),
    fl.asInt('page_size', DEFAULT_PAGE_SIZE),
    account.maxMessages,
  )
  const budget = uidBudget(page, pageSize, [], account.maxMessages)
  const accessor = new EmailAccessor(account)
  let headers
  try {
    const uids = await listMessageUids(accessor, mailbox, 'ALL', budget)
    headers = uids.length > 0 ? await fetchHeaders(accessor, mailbox, uids) : []
  } finally {
    await accessor.close()
  }
  const pageOf = pageSlice(sortHeaders(headers, []), page, pageSize)
  const out: ByteSource = envelopesJsonBytes(pageOf)
  return [out, new IOResult()]
}
