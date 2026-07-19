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
  CommandSpec,
  IOResult,
  OperandKind,
  Option,
  ResourceName,
  command,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { fetchHeaders } from '../../../core/email/_client.ts'
import { searchMessages } from '../../../core/email/search.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--folder', valueKind: OperandKind.TEXT }),
    new Option({ long: '--max', valueKind: OperandKind.TEXT }),
    new Option({ long: '--unseen' }),
    new Option({ long: '--subject', valueKind: OperandKind.TEXT }),
    new Option({ long: '--from', valueKind: OperandKind.TEXT }),
    new Option({ long: '--to', valueKind: OperandKind.TEXT }),
    new Option({ long: '--body', valueKind: OperandKind.TEXT }),
    new Option({ long: '--since', valueKind: OperandKind.TEXT }),
    new Option({ long: '--before', valueKind: OperandKind.TEXT }),
  ],
})

async function emailTriageCommand(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const folder = typeof opts.flags.folder === 'string' ? opts.flags.folder : 'INBOX'
  const maxResults = typeof opts.flags.max === 'string' ? Number.parseInt(opts.flags.max, 10) : 20
  const uids = await searchMessages(
    accessor,
    folder,
    {
      text: typeof opts.flags.body === 'string' ? opts.flags.body : null,
      subject: typeof opts.flags.subject === 'string' ? opts.flags.subject : null,
      fromAddr: typeof opts.flags.from === 'string' ? opts.flags.from : null,
      toAddr: typeof opts.flags.to === 'string' ? opts.flags.to : null,
      since: typeof opts.flags.since === 'string' ? opts.flags.since : null,
      before: typeof opts.flags.before === 'string' ? opts.flags.before : null,
      unseen: opts.flags.unseen === true,
    },
    maxResults,
  )
  if (uids.length === 0) {
    const out: ByteSource = ENC.encode('[]')
    return [out, new IOResult()]
  }
  const headers = await fetchHeaders(accessor, folder, uids)
  const out: ByteSource = ENC.encode(JSON.stringify(headers))
  return [out, new IOResult()]
}

export const EMAIL_TRIAGE = command({
  name: 'himalaya envelope list',
  resource: ResourceName.EMAIL,
  spec: SPEC,
  fn: emailTriageCommand,
})
