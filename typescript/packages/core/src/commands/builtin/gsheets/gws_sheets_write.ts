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
import { SHEETS_API_BASE, googleHeaders } from '../../../core/google/_client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--params', valueKind: OperandKind.TEXT }),
    new Option({ long: '--json', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.PATH }),
})

async function gwsSheetsWriteCommand(
  accessor: GoogleApiAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const paramsStr = typeof opts.flags.params === 'string' ? opts.flags.params : ''
  const jsonStr = typeof opts.flags.json === 'string' ? opts.flags.json : ''
  if (paramsStr === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--params is required\n') })]
  }
  if (jsonStr === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('--json is required\n') })]
  }
  let params: { spreadsheetId?: string; range?: string; valueInputOption?: string }
  try {
    params = JSON.parse(paramsStr) as typeof params
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`Invalid JSON: ${msg}\n`) })]
  }
  const sheetId = params.spreadsheetId ?? ''
  const range = params.range ?? ''
  const vio = params.valueInputOption ?? 'USER_ENTERED'
  if (sheetId === '') {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('--params must contain spreadsheetId\n') }),
    ]
  }
  if (range === '') {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('--params must contain range\n') }),
    ]
  }
  const url = `${SHEETS_API_BASE}/spreadsheets/${sheetId}/values/${range}?valueInputOption=${vio}`
  const headers = await googleHeaders(accessor.tokenManager)
  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: jsonStr,
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`Sheets PUT ${url} → ${String(r.status)} ${text}\n`),
      }),
    ]
  }
  const result = (await r.json()) as unknown
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}

export const GSHEETS_GWS_WRITE = command({
  name: 'gws sheets +write',
  resource: [ResourceName.GSHEETS, ResourceName.GDRIVE],
  spec: SPEC,
  fn: gwsSheetsWriteCommand,
  write: true,
})
