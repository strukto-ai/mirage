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
  type CLIVerbOpts,
  type CommandFnResult,
  type PathSpec,
} from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchHeaders } from '../../../../core/email/_client.ts'
import { searchMessages } from '../../../../core/email/search.ts'
import type { EmailConfig } from '../../../../resource/email/config.ts'

const ENC = new TextEncoder()

export async function listEnvelopes(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const folder = fl.asStr('folder') ?? 'INBOX'
  const maxResults = fl.asInt('max') ?? 20
  const accessor = new EmailAccessor(config as EmailConfig)
  let headers
  try {
    const uids = await searchMessages(
      accessor,
      folder,
      {
        text: fl.asStr('body') ?? null,
        subject: fl.asStr('subject') ?? null,
        fromAddr: fl.asStr('from') ?? null,
        toAddr: fl.asStr('to') ?? null,
        since: fl.asStr('since') ?? null,
        before: fl.asStr('before') ?? null,
        unseen: fl.asBool('unseen'),
      },
      maxResults,
    )
    headers = uids.length > 0 ? await fetchHeaders(accessor, folder, uids) : []
  } finally {
    await accessor.close()
  }
  const out: ByteSource = ENC.encode(JSON.stringify(headers))
  return [out, new IOResult()]
}
