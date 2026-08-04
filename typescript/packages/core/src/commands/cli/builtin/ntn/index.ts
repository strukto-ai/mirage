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

import { NotionConfigSchema } from '../../../../core/notion/config.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec } from '../../types.ts'
import { Option } from '../../../spec/types.ts'
import { append } from './blocks/append.ts'
import { create as commentCreate } from './comments/create.ts'
import { query } from './datasources/query.ts'
import { create } from './pages/create.ts'
import { edit } from './pages/edit.ts'
import { get } from './pages/get.ts'
import { trash } from './pages/trash.ts'
import { search } from './search.ts'

// The ntn program tree, following the official Notion CLI grammar
// (`ntn pages get/create/edit/trash`, `ntn datasources query`). blocks,
// comments and search are mirage extensions spelled with the REST API's
// nouns; the official CLI reaches them through `ntn api`, which mirage
// does not ship (this transport speaks MCP tool names, not raw REST
// paths). Install with a NotionConfig.
export const NTN = new CLISpec({
  name: 'ntn',
  description: 'Notion API client',
  configModel: NotionConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'pages',
      description: 'Manage pages',
      subcommands: [
        new CLISpec({
          name: 'get',
          description: 'Retrieve a page',
          fn: get,
          options: [new Option({ long: '--page', type: 'str', required: true })],
        }),
        new CLISpec({
          name: 'create',
          description: 'Create a page from a JSON body',
          fn: create,
          write: true,
          options: [
            new Option({
              long: '--json',
              type: 'str',
              required: true,
              description: 'Page body with parent and properties, as the POST /pages API resource',
            }),
          ],
        }),
        new CLISpec({
          name: 'edit',
          description: "Update a page's properties from JSON",
          fn: edit,
          write: true,
          options: [
            new Option({ long: '--page', type: 'str', required: true }),
            new Option({
              long: '--json',
              type: 'str',
              required: true,
              description: 'PATCH /pages body',
            }),
          ],
        }),
        new CLISpec({
          name: 'trash',
          description: 'Move a page to the trash',
          fn: trash,
          write: true,
          options: [new Option({ long: '--page', type: 'str', required: true })],
        }),
      ],
    }),
    new CLISpec({
      name: 'blocks',
      description: 'Manage blocks',
      subcommands: [
        new CLISpec({
          name: 'append',
          description: 'Append child blocks to a block or page',
          fn: append,
          write: true,
          options: [
            new Option({ long: '--block', type: 'str', required: true }),
            new Option({
              long: '--json',
              type: 'str',
              required: true,
              description: 'Body with a children array',
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'comments',
      description: 'Manage comments',
      subcommands: [
        new CLISpec({
          name: 'create',
          description: 'Add a comment to a page or discussion',
          fn: commentCreate,
          write: true,
          options: [
            new Option({
              long: '--json',
              type: 'str',
              required: true,
              description: 'Body with parent and rich_text',
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'datasources',
      description: 'Query data sources',
      subcommands: [
        new CLISpec({
          name: 'query',
          description: "Query a database's pages",
          fn: query,
          options: [
            new Option({
              long: '--datasource',
              type: 'str',
              required: true,
              description: 'Database ID',
            }),
            new Option({ long: '--json', type: 'str', description: 'Filter and sorts body' }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'search',
      description: 'Search pages by title',
      fn: search,
      options: [
        new Option({ long: '--query', type: 'str', required: true }),
        new Option({ long: '--limit', type: 'int', description: 'Max results (default: 20)' }),
      ],
    }),
  ],
})

registerCliSpec(NTN)
