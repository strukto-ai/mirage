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
import { getMessageProcessed } from '../../../core/gmail/messages.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  description:
    'Fetch a single Gmail message as processed JSON (same shape as cat <path>.gmail.json).',
  options: [
    new Option({
      long: '--id',
      valueKind: OperandKind.TEXT,
      description: 'Gmail message ID (required)',
    }),
  ],
})

async function gwsGmailReadCommand(
  accessor: GmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const id = typeof opts.flags.id === 'string' ? opts.flags.id : ''
  if (id === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--id is required\n') })]
  }
  const processed = await getMessageProcessed(accessor.tokenManager, id)
  const out: ByteSource = ENC.encode(JSON.stringify(processed))
  return [out, new IOResult()]
}

export const GMAIL_GWS_READ = command({
  name: 'gws gmail +read',
  resource: ResourceName.GMAIL,
  spec: SPEC,
  fn: gwsGmailReadCommand,
})
