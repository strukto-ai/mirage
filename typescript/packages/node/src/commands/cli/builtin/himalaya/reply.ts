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

import { FlagView, type CLIInvocation, type CommandFnResult } from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchMessage } from '../../../../core/email/_client.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { firstText, route } from './util.ts'

export async function reply(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const uid = firstText(inv.texts, 'message id')
  const mailbox = fl.asStr('mailbox') ?? 'INBOX'
  const accessor = new EmailAccessor(inv.config as EmailConfig)
  let original
  try {
    original = await fetchMessage(accessor, mailbox, uid)
  } finally {
    await accessor.close()
  }
  return route(
    inv.config as EmailConfig,
    fl,
    inv.stdin,
    {
      message: original,
      mode: 'reply',
      postingStyle: fl.asStr('posting_style') === 'bottom' ? 'bottom' : 'top',
      quoteHeadline: fl.asStr('quote_headline') ?? '',
    },
    inv.ops,
  )
}
