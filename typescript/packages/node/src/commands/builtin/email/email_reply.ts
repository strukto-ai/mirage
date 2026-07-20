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
import { fetchMessage } from '../../../core/email/_client.ts'
import { replyAllMessage, replyMessage } from '../../../core/email/send.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--uid', valueKind: OperandKind.TEXT }),
    new Option({ long: '--folder', valueKind: OperandKind.TEXT }),
    new Option({ long: '--body', valueKind: OperandKind.TEXT }),
    new Option({ long: '--all' }),
  ],
})

async function emailReplyCommand(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const uid = typeof opts.flags.uid === 'string' ? opts.flags.uid : ''
  const folder = typeof opts.flags.folder === 'string' ? opts.flags.folder : ''
  const body = typeof opts.flags.body === 'string' ? opts.flags.body : ''
  if (uid === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--uid is required\n') })]
  }
  if (folder === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--folder is required\n') })]
  }
  if (body === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--body is required\n') })]
  }
  const original = await fetchMessage(accessor, folder, uid)
  const result =
    opts.flags.all === true
      ? await replyAllMessage(accessor.config, original, body)
      : await replyMessage(accessor.config, original, body)
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const EMAIL_REPLY = command({
  name: 'himalaya message reply',
  resource: ResourceName.EMAIL,
  spec: SPEC,
  fn: emailReplyCommand,
  write: true,
})
