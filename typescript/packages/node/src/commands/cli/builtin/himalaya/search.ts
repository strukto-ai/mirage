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
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchHeaders, listMessageUids } from '../../../../core/email/client.ts'
import { envelopesJsonBytes } from '../../../../core/email/render.ts'
import { DEFAULT_PAGE_SIZE } from './list.ts'
import { pageSlice, pageWindow, parseQuery, sortHeaders, uidBudget } from './query.ts'

export async function searchEnvelopes(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const mailbox = fl.asStr('mailbox', 'INBOX')
  const [page, pageSize] = pageWindow(
    fl.asInt('page', 1),
    fl.asInt('page_size', DEFAULT_PAGE_SIZE),
    accessor.config.maxMessages,
  )
  // The shell already split the query; upstream joins argv the same way
  // before parsing, so a pattern with spaces needs literal quotes.
  const query = parseQuery(texts.join(' '))
  const budget = uidBudget(page, pageSize, query.sorters, accessor.config.maxMessages)
  const uids = await listMessageUids(accessor, mailbox, query.criteria, budget)
  const headers = uids.length > 0 ? await fetchHeaders(accessor, mailbox, uids) : []
  const pageOf = pageSlice(sortHeaders(headers, query.sorters), page, pageSize)
  const out: ByteSource = envelopesJsonBytes(pageOf)
  return [out, new IOResult()]
}
