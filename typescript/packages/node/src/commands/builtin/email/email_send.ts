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
import { sendMessage } from '../../../core/email/send.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--to', valueKind: OperandKind.TEXT }),
    new Option({ long: '--subject', valueKind: OperandKind.TEXT }),
    new Option({ long: '--body', valueKind: OperandKind.TEXT }),
  ],
})

async function emailSendCommand(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const to = typeof opts.flags.to === 'string' ? opts.flags.to : ''
  const subject = typeof opts.flags.subject === 'string' ? opts.flags.subject : ''
  const body = typeof opts.flags.body === 'string' ? opts.flags.body : ''
  if (to === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--to is required\n') })]
  }
  if (subject === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--subject is required\n') })]
  }
  if (body === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--body is required\n') })]
  }
  const result = await sendMessage(accessor.config, to, subject, body)
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const EMAIL_SEND = command({
  name: 'himalaya message send',
  resource: ResourceName.EMAIL,
  spec: SPEC,
  fn: emailSendCommand,
  write: true,
})
