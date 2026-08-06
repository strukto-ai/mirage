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

import { FlagView } from '../../../spec/types.ts'
import { searchPages } from '../../../../core/notion/pages.ts'
import { extractTitle } from '../../../../core/notion/normalize.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { notionTransport } from './util.ts'

const ENC = new TextEncoder()

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export async function search(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const limit = fl.asInt('limit') ?? 20
  const pages = await searchPages(
    notionTransport(inv.config),
    fl.asStr('query') ?? '',
    limit,
    limit,
  )
  const results = pages.slice(0, limit).map((page) => {
    const parent = page.parent as Record<string, unknown> | undefined
    const title = extractTitle(page)
    return {
      // extractTitle falls back to 'untitled'; spell it like Python's
      // "Untitled" so the shared integ goldens agree.
      title: title === 'untitled' ? 'Untitled' : title,
      page_id: str(page.id),
      url: str(page.url),
      last_edited: str(page.last_edited_time),
      parent_type: str(parent?.type),
    }
  })
  const out: ByteSource = ENC.encode(JSON.stringify(results))
  return [out, new IOResult()]
}
