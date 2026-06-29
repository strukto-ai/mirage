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
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { fileReadProvision, metadataProvision } from './_provision.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { NOTION_BLOCK_APPEND } from './notion_block_append.ts'
import { NOTION_COMMENT_ADD } from './notion_comment_add.ts'
import { NOTION_FIND } from './find.ts'
import { NOTION_PAGE_CREATE } from './notion_page_create.ts'
import { NOTION_SEARCH } from './notion_search.ts'
import { NOTION_CMD_OPS } from './ops.ts'

const NOTION_OVERRIDES = new Set(['find'])

export const NOTION_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<NotionAccessor>(ResourceName.NOTION, NOTION_CMD_OPS, {
    overrides: NOTION_OVERRIDES,
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...NOTION_FIND,
  ...NOTION_BLOCK_APPEND,
  ...NOTION_COMMENT_ADD,
  ...NOTION_PAGE_CREATE,
  ...NOTION_SEARCH,
]
