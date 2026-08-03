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
import { normalizePage, toJsonBytes } from '../../../core/notion/normalize.ts'
import { appendBlocks, getChildBlocks, getPage } from '../../../core/notion/pages.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--params', type: 'str' }),
    new Option({ long: '--json', type: 'str' }),
  ] })

async function notionBlockAppendCommand(
  accessor: NotionAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const paramsStr = opts.flags.params
  if (typeof paramsStr !== 'string' || paramsStr === '') {
    throw new Error('--params is required (must contain block_id)')
  }
  const jsonStr = opts.flags.json
  if (typeof jsonStr !== 'string' || jsonStr === '') {
    throw new Error('--json is required (must contain children)')
  }
  const params = JSON.parse(paramsStr) as Record<string, unknown>
  const blockId = typeof params.block_id === 'string' ? params.block_id : ''
  if (blockId === '') {
    throw new Error('--params must contain block_id')
  }
  const body = JSON.parse(jsonStr) as Record<string, unknown>
  await appendBlocks(accessor.transport, blockId, body)
  const page = await getPage(accessor.transport, blockId)
  const pageBlocks = await getChildBlocks(accessor.transport, blockId)
  return [toJsonBytes(normalizePage(page, pageBlocks)), new IOResult()]
}

export const NOTION_BLOCK_APPEND = command({
  name: 'notion-block-append',
  resource: ResourceName.NOTION,
  spec: SPEC,
  fn: notionBlockAppendCommand,
  write: true })
