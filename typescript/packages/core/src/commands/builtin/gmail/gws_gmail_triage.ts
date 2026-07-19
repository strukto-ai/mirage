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

import type { GmailAccessor } from '../../../accessor/gmail.ts'
import { extractHeader, getMessageRaw, listMessages } from '../../../core/gmail/messages.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  description:
    'List message summaries (id, from, subject, date, snippet) for a Gmail search query.',
  options: [
    new Option({
      long: '--query',
      valueKind: OperandKind.TEXT,
      description: 'Gmail search query, e.g. "is:unread" (default: is:unread)',
    }),
    new Option({
      long: '--max',
      valueKind: OperandKind.TEXT,
      description: 'Max results to return (default: 20)',
    }),
  ],
})

async function gwsGmailTriageCommand(
  accessor: GmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = typeof opts.flags.query === 'string' ? opts.flags.query : 'is:unread'
  const maxResults = typeof opts.flags.max === 'string' ? Number.parseInt(opts.flags.max, 10) : 20
  const stubs = await listMessages(accessor.tokenManager, { query, maxResults })
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
    const raw = await getMessageRaw(accessor.tokenManager, mid)
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

export const GMAIL_GWS_TRIAGE = command({
  name: 'gws gmail +triage',
  resource: ResourceName.GMAIL,
  spec: SPEC,
  fn: gwsGmailTriageCommand,
})
