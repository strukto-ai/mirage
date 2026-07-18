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
import { find as notionFind } from '../../../core/notion/find.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { NOTION_IO } from './io.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'
import { metadataProvision } from '../generic_bind/provision.ts'

const resolveNotionGlob = resolveGlobOf(NOTION_IO)

async function findCommand(
  accessor: NotionAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveNotionGlob(accessor, paths, opts.index ?? undefined)
  return findGeneric(resolved, texts, opts, (root, options) =>
    notionFind(accessor, root, options, opts.index ?? undefined),
  )
}

export const NOTION_FIND = command({
  name: 'find',
  resource: ResourceName.NOTION,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
