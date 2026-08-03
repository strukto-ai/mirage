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
import { normalizePage } from '../../../core/notion/normalize.ts'
import { createPage, type CreatePageInput } from '../../../core/notion/pages.ts'
import { parseSegment } from '../../../core/notion/pathing.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--parent', type: 'path' }),
    new Option({ long: '--title', type: 'str' }),
  ],
})

function resolveParent(rawParent: string, mountPrefix: string): CreatePageInput['parent'] {
  let path = rawParent
  if (mountPrefix !== '' && path.startsWith(mountPrefix)) {
    path = path.slice(mountPrefix.length)
  }
  while (path.startsWith('/')) path = path.slice(1)
  while (path.endsWith('/')) path = path.slice(0, -1)
  if (path === '') {
    return { type: 'workspace' }
  }
  const segments = path.split('/')
  const last = segments[segments.length - 1] ?? ''
  let parsed: { id: string }
  try {
    parsed = parseSegment(last)
  } catch {
    throw new Error(`invalid parent path: ${rawParent}`)
  }
  return { type: 'page_id', page_id: parsed.id }
}

async function notionPageCreateCommand(
  accessor: NotionAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parentRaw = opts.flags.parent
  if (typeof parentRaw !== 'string' || parentRaw === '') {
    throw new Error('--parent is required')
  }
  const title = opts.flags.title
  if (typeof title !== 'string' || title === '') {
    throw new Error('--title is required')
  }
  const parent = resolveParent(parentRaw, opts.mountPrefix ?? '')
  const created = await createPage(accessor.transport, { parent, title })
  return [ENC.encode(JSON.stringify(normalizePage(created, []), null, 2)), new IOResult()]
}

export const NOTION_PAGE_CREATE = command({
  name: 'notion-page-create',
  resource: ResourceName.NOTION,
  spec: SPEC,
  fn: notionPageCreateCommand,
  write: true,
})
