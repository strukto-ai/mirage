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
import { readValues } from '../../../core/gsheets/read.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--spreadsheet', valueKind: OperandKind.TEXT }),
    new Option({ long: '--range', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.PATH }),
})

async function gwsSheetsReadCommand(
  accessor: GoogleApiAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const sheetId = typeof opts.flags.spreadsheet === 'string' ? opts.flags.spreadsheet : ''
  const range = typeof opts.flags.range === 'string' ? opts.flags.range : ''
  if (sheetId === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--spreadsheet is required\n') })]
  }
  if (range === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--range is required\n') })]
  }
  const result = await readValues(accessor.tokenManager, sheetId, range)
  const out: ByteSource = result
  return [out, new IOResult()]
}

export const GSHEETS_GWS_READ = command({
  name: 'gws sheets +read',
  resource: [ResourceName.GSHEETS, ResourceName.GDRIVE],
  spec: SPEC,
  fn: gwsSheetsReadCommand,
})
