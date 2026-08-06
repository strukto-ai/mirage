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

import { FlagView } from '../../../../../commands/spec/types.ts'
import { TokenManager } from '../../../../../core/google/_client.ts'
import type { GoogleConfig } from '../../../../../core/google/config.ts'
import { updateValues } from '../../../../../core/gsheets/write.ts'
import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../../commands/config.ts'
import type { CLIInvocation } from '../../../../../commands/cli/types.ts'

const ENC = new TextEncoder()

// Read the 2D values payload: --json-values wins over --values.
export function valuesJsonFromFlags(fl: FlagView): string {
  const jsonValues = fl.asStr('json_values')
  if (jsonValues !== undefined && jsonValues !== '') return jsonValues
  const valuesCsv = fl.asStr('values')
  if (valuesCsv !== undefined && valuesCsv !== '') {
    return JSON.stringify([valuesCsv.split(',')])
  }
  throw new Error('--values or --json-values is required')
}

export async function write(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const result = await updateValues(
    new TokenManager(inv.config as GoogleConfig),
    fl.asStr('spreadsheet') ?? '',
    fl.asStr('range') ?? '',
    valuesJsonFromFlags(fl),
  )
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}
