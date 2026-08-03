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

import type { NotionAccessor } from '../../../accessor/notion.ts'
import { pageContentTitle } from '../../../core/notion/normalize.ts'
import { searchPages } from '../../../core/notion/pages.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--query', type: 'str' }),
    new Option({ long: '--limit', type: 'str' }),
  ] })

function strOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function notionSearchCommand(
  accessor: NotionAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = opts.flags.query
  if (typeof query !== 'string' || query === '') {
    throw new Error('--query is required')
  }
  const limitRaw = opts.flags.limit
  let limit = 20
  if (typeof limitRaw === 'string') {
    limit = Number.parseInt(limitRaw, 10)
    if (Number.isNaN(limit)) {
      throw new Error(`invalid --limit: ${limitRaw}`)
    }
  }
  const pages = await searchPages(accessor.transport, query, limit)
  const results: Record<string, string>[] = []
  for (const page of pages.slice(0, limit)) {
    const title = pageContentTitle(page)
    const parent = page.parent
    const parentObj =
      parent !== null && typeof parent === 'object' && !Array.isArray(parent)
        ? (parent as Record<string, unknown>)
        : {}
    results.push({
      title: title !== '' ? title : 'Untitled',
      page_id: strOf(page, 'id'),
      url: strOf(page, 'url'),
      last_edited: strOf(page, 'last_edited_time'),
      parent_type: strOf(parentObj, 'type') })
  }
  return [ENC.encode(JSON.stringify(results, null, 2)), new IOResult()]
}

export const NOTION_SEARCH = command({
  name: 'notion-search',
  resource: ResourceName.NOTION,
  spec: SPEC,
  fn: notionSearchCommand })
