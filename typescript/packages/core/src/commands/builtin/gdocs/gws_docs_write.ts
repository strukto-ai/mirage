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

import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import { appendText } from '../../../core/gdocs/write.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--document', valueKind: OperandKind.TEXT }),
    new Option({ long: '--text', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.PATH }),
})

async function gwsDocsWriteCommand(
  accessor: GoogleApiAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const docId = typeof opts.flags.document === 'string' ? opts.flags.document : ''
  const text = typeof opts.flags.text === 'string' ? opts.flags.text : ''
  if (docId === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--document is required\n') })]
  }
  if (text === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--text is required\n') })]
  }
  const result = await appendText(accessor.tokenManager, docId, text)
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const GDOCS_GWS_WRITE = command({
  name: 'gws docs +write',
  resource: [ResourceName.GDOCS, ResourceName.GDRIVE],
  spec: SPEC,
  fn: gwsDocsWriteCommand,
  write: true,
})
