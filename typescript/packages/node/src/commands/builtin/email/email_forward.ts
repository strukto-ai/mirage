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
import { forwardMessage } from '../../../core/email/send.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--uid', valueKind: OperandKind.TEXT }),
    new Option({ long: '--folder', valueKind: OperandKind.TEXT }),
    new Option({ long: '--to', valueKind: OperandKind.TEXT }),
  ],
})

async function emailForwardCommand(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const uid = typeof opts.flags.uid === 'string' ? opts.flags.uid : ''
  const folder = typeof opts.flags.folder === 'string' ? opts.flags.folder : ''
  const to = typeof opts.flags.to === 'string' ? opts.flags.to : ''
  if (uid === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--uid is required\n') })]
  }
  if (folder === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--folder is required\n') })]
  }
  if (to === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--to is required\n') })]
  }
  const original = await fetchMessage(accessor, folder, uid)
  const result = await forwardMessage(accessor.config, original, to)
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const EMAIL_FORWARD = command({
  name: 'himalaya message forward',
  resource: ResourceName.EMAIL,
  spec: SPEC,
  fn: emailForwardCommand,
  write: true,
})
