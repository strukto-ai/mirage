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

import {
  FlagView,
  IOResult,
  type ByteSource,
  type CLIInvocation,
  type CommandFnResult,
} from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchHeaders, listMessageUids } from '../../../../core/email/_client.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { DEFAULT_PAGE_SIZE } from './list.ts'
import { pageSlice, parseQuery, sortHeaders, uidBudget } from './query.ts'

const ENC = new TextEncoder()

export async function searchEnvelopes(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const mailbox = fl.asStr('mailbox') ?? 'INBOX'
  const page = fl.asInt('page') ?? 1
  const pageSize = fl.asInt('page_size') ?? DEFAULT_PAGE_SIZE
  // The shell already split the query; upstream joins argv the same way
  // before parsing, so a pattern with spaces needs literal quotes.
  const query = parseQuery(inv.texts.join(' '))
  const account = inv.config as EmailConfig
  const budget = uidBudget(page, pageSize, query.sorters, account.maxMessages)
  const accessor = new EmailAccessor(account)
  let headers
  try {
    const uids = await listMessageUids(accessor, mailbox, query.criteria, budget)
    headers = uids.length > 0 ? await fetchHeaders(accessor, mailbox, uids) : []
  } finally {
    await accessor.close()
  }
  const pageOf = pageSlice(sortHeaders(headers, query.sorters), page, pageSize)
  const out: ByteSource = ENC.encode(JSON.stringify(pageOf))
  return [out, new IOResult()]
}
