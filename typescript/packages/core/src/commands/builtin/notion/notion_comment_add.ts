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
import { toJsonBytes } from '../../../core/notion/normalize.ts'
import { createComment } from '../../../core/notion/pages.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const SPEC = new CommandSpec({
  options: [new Option({ long: '--json', type: 'str' })] })

async function notionCommentAddCommand(
  accessor: NotionAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const jsonStr = opts.flags.json
  if (typeof jsonStr !== 'string' || jsonStr === '') {
    throw new Error(
      'Usage: notion-comment-add --json \'{"parent":{"page_id":"..."},' +
        '"rich_text":[{"text":{"content":"Comment text"}}]}\'',
    )
  }
  const body = JSON.parse(jsonStr) as Record<string, unknown>
  if (!('parent' in body)) {
    throw new Error("JSON must contain 'parent'")
  }
  const comment = await createComment(accessor.transport, body)
  return [toJsonBytes(comment), new IOResult()]
}

export const NOTION_COMMENT_ADD = command({
  name: 'notion-comment-add',
  resource: ResourceName.NOTION,
  spec: SPEC,
  fn: notionCommentAddCommand,
  write: true })
