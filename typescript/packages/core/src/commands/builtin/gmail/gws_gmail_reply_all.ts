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
import { replyAllMessage } from '../../../core/gmail/send.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  description: 'Reply to a Gmail message including all original recipients (To and CC).',
  options: [
    new Option({
      long: '--message-id',
      valueKind: OperandKind.TEXT,
      description: 'Gmail message ID to reply to (required)',
    }),
    new Option({
      long: '--body',
      valueKind: OperandKind.TEXT,
      description: "Reply body; use $'\\n' or printf for real newlines (required)",
    }),
  ],
})

async function gwsGmailReplyAllCommand(
  accessor: GmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const messageId =
    typeof opts.flags['message-id'] === 'string'
      ? opts.flags['message-id']
      : typeof opts.flags.message_id === 'string'
        ? opts.flags.message_id
        : ''
  const body = typeof opts.flags.body === 'string' ? opts.flags.body : ''
  if (messageId === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--message-id is required\n') })]
  }
  if (body === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--body is required\n') })]
  }
  const result = await replyAllMessage(accessor.tokenManager, messageId, body)
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const GMAIL_GWS_REPLY_ALL = command({
  name: 'gws gmail +reply-all',
  resource: ResourceName.GMAIL,
  spec: SPEC,
  fn: gwsGmailReplyAllCommand,
  write: true,
})
