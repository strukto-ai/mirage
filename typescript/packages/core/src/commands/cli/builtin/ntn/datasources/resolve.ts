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

import { FlagView } from '../../../../spec/types.ts'
import { getDatabase } from '../../../../../core/notion/pages.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { firstText, notionTransport, prettyJson, usageError } from '../util.ts'

const ENC = new TextEncoder()

export async function resolve(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  let databaseId: string
  try {
    databaseId = firstText(inv.texts, 'database id')
  } catch (err) {
    return usageError(err)
  }
  const database = await getDatabase(notionTransport(inv.config, inv.flags), databaseId)
  const stubs = Array.isArray(database.data_sources) ? database.data_sources : []
  if (fl.asBool('json')) {
    return [prettyJson({ database_id: databaseId, data_sources: stubs }), new IOResult()]
  }
  let out = ''
  for (const one of stubs) {
    const record = one as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const name = typeof record.name === 'string' ? record.name : ''
    out += `${id}\t${name}\n`
  }
  return [ENC.encode(out), new IOResult()]
}
