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
import { createPageRaw } from '../../../../../core/notion/pages.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { contentOrStdin, notionTransport, prettyJson, usageError } from '../util.ts'

const ENC = new TextEncoder()
const PARENT_KEYS: Record<string, string> = {
  page: 'page_id',
  database: 'database_id',
  'data-source': 'data_source_id',
}

function parseParent(spec: string): Record<string, unknown> {
  const at = spec.indexOf(':')
  const kind = at === -1 ? spec : spec.slice(0, at)
  const ident = at === -1 ? '' : spec.slice(at + 1)
  const key = PARENT_KEYS[kind]
  if (key === undefined || ident === '') {
    throw new Error('--parent must be page:<id>, database:<id>, or data-source:<id>')
  }
  return { [key]: ident }
}

export async function create(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const body: Record<string, unknown> = {}
  try {
    body.markdown = await contentOrStdin(fl.asStr('content'), inv.stdin)
    // The parent really is optional upstream: omitted, the request goes out
    // without one and the API decides whether to refuse it.
    const parent = fl.asStr('parent')
    if (parent !== undefined && parent !== '') body.parent = parseParent(parent)
  } catch (err) {
    return usageError(err)
  }
  const page = await createPageRaw(notionTransport(inv.config, inv.flags), body)
  if (fl.asBool('json')) return [prettyJson(page), new IOResult()]
  const id = typeof page.id === 'string' ? page.id : ''
  return [ENC.encode(`${id}\n`), new IOResult()]
}
