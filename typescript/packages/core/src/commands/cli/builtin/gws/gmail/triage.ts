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

import { FlagView } from '../../../../../commands/spec/types.ts'
import { extractHeader, getMessageRaw, listMessages } from '../../../../../core/gmail/messages.ts'
import { TokenManager } from '../../../../../core/google/_client.ts'
import type { GoogleConfig } from '../../../../../core/google/config.ts'
import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../../commands/config.ts'
import type { CLIInvocation } from '../../../../../commands/cli/types.ts'

const ENC = new TextEncoder()

export async function triage(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const query = fl.asStr('query') ?? 'is:unread'
  const maxResults = fl.asInt('max') ?? 20
  const tm = new TokenManager(inv.config as GoogleConfig)
  const stubs = await listMessages(tm, { query, maxResults })
  const summaries: {
    id: string
    from: string
    subject: string
    date: string
    snippet: string
  }[] = []
  for (const stub of stubs) {
    const mid = stub.id
    if (mid === '') continue
    const raw = await getMessageRaw(tm, mid)
    const headers = raw.payload?.headers ?? []
    summaries.push({
      id: mid,
      from: extractHeader(headers, 'From'),
      subject: extractHeader(headers, 'Subject'),
      date: extractHeader(headers, 'Date'),
      snippet: raw.snippet ?? '',
    })
  }
  const out: ByteSource = ENC.encode(JSON.stringify(summaries))
  return [out, new IOResult()]
}
