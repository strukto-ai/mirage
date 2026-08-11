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
import { Operand, Option, UsageStyle } from '../../../spec/types.ts'
import { api } from './api.ts'
import { guarded } from './failure.ts'
import { token } from './auth/token.ts'
import { query } from './datasources/query.ts'
import { resolve } from './datasources/resolve.ts'
import { create } from './pages/create.ts'
import { edit } from './pages/edit.ts'
import { get } from './pages/get.ts'
import { trash } from './pages/trash.ts'
import { whoami } from './whoami.ts'

// Operand names are upstream's, verbatim: they are what the refusal for a
// missing one prints, so they are part of the grammar rather than
// documentation. Each verb names its own, which is why there is no one shared
// ID slot.
const PAGE_ID = new Operand({ type: 'str', name: 'PAGE_ID', required: true })
const DATA_SOURCE_ID = new Operand({ type: 'str', name: 'ID_OR_URL', required: true })
const DATABASE_ID = new Operand({ type: 'str', name: 'ID', required: true })
const API_PATH = new Operand({ type: 'str', name: 'PATH' })
const jsonOut = (): Option =>
  new Option({ long: '--json', type: 'bool', description: 'Output the raw API response as JSON' })
const plain = (): Option =>
  new Option({
    long: '--plain',
    type: 'bool',
    description: 'Output as tab-separated values with no headers',
  })
// NOTION_API_VERSION is upstream's own environment fallback, and naming it
// here is what makes the flag real: the executor fills the value from the
// session, so a leaf reads one flag rather than a flag and a fallback, and a
// usage line counts the option as supplied the way clap does.
const notionVersion = (): Option =>
  new Option({
    long: '--notion-version',
    type: 'str',
    metavar: 'VERSION',
    env: 'NOTION_API_VERSION',
    description: 'Override the Notion-Version header',
  })
const content = (): Option =>
  new Option({
    long: '--content',
    type: 'str',
    description: 'Markdown body (also read from stdin)',
  })

// The ntn program tree, matching the official Notion CLI's grammar verb for
// verb: ids are positional, `pages get` renders Markdown with a frontmatter
// title, and the REST surface that has no typed verb is reached through
// `ntn api` exactly as upstream reaches it. There is no `ntn blocks`/`ntn
// comments`/`ntn search`; those are `ntn api v1/blocks/...`, `ntn api
// v1/comments` and `ntn api v1/search`. Upstream's interactive and deploy
// verbs (`login`, `logout`, `update`, `workers`, `notion-as-code`, `doctor`,
// `files`) are out of scope for a virtualized CLI. Install with a NotionConfig.
export const NTN = new CLISpec({
  name: 'ntn',
  description: 'Notion CLI (Beta)',
  configModel: NotionConfigSchema,
  // Upstream is a clap program, so this one answers in clap's voice: its help
  // layout and its refusal for a missing operand are pinned against the real
  // binary by integ/ntn_conformance.ts.
  usageStyle: UsageStyle.CLAP,
  subcommands: [
    new CLISpec({
      name: 'api',
      description: 'Call the public Notion API (beta)',
      fn: guarded(api),
      write: true,
      rest: API_PATH,
      options: [
        new Option({
          long: '--data',
          short: '-d',
          type: 'str',
          description: 'Use a JSON string as the request body',
        }),
        new Option({
          long: '--method',
          short: '-X',
          type: 'str',
          description: 'Override the inferred HTTP method',
        }),
        notionVersion(),
      ],
    }),
    new CLISpec({
      name: 'auth',
      description: 'Inspect authentication credentials',
      subcommands: [
        new CLISpec({
          name: 'token',
          description: 'Print the current authentication token',
          fn: guarded(token),
        }),
      ],
    }),
    new CLISpec({
      name: 'datasources',
      description: 'Manage data sources',
      subcommands: [
        new CLISpec({
          name: 'query',
          description: 'Query pages in a data source',
          fn: guarded(query),
          positional: [DATA_SOURCE_ID],
          options: [
            new Option({ long: '--limit', type: 'int', description: 'Maximum rows to return' }),
            new Option({
              long: '--start-cursor',
              type: 'str',
              description: 'Cursor to resume from',
            }),
            new Option({
              long: '--sort',
              short: '-s',
              type: 'str',
              multiple: true,
              metavar: 'SPEC',
              description: "'<property> [asc|desc]'",
            }),
            new Option({
              long: '--filter',
              type: 'str',
              metavar: 'JSON',
              description: 'Filter as a JSON object',
            }),
            new Option({
              long: '--filter-file',
              type: 'path',
              metavar: 'PATH',
              description: 'Read the filter from a file',
            }),
            jsonOut(),
            plain(),
            notionVersion(),
          ],
        }),
        new CLISpec({
          name: 'resolve',
          description: 'Resolve a Notion database ID to its data source IDs',
          fn: guarded(resolve),
          positional: [DATABASE_ID],
          options: [jsonOut(), notionVersion()],
        }),
      ],
    }),
    new CLISpec({
      name: 'pages',
      description: 'Manage pages',
      subcommands: [
        new CLISpec({
          name: 'get',
          description: 'Retrieve a page as Markdown',
          fn: guarded(get),
          positional: [PAGE_ID],
          options: [jsonOut(), notionVersion()],
        }),
        new CLISpec({
          name: 'create',
          description: 'Create a page from Markdown content',
          fn: guarded(create),
          write: true,
          options: [
            content(),
            new Option({
              long: '--parent',
              type: 'str',
              description: 'page:<id>, database:<id>, or data-source:<id>',
            }),
            jsonOut(),
            notionVersion(),
          ],
        }),
        new CLISpec({
          name: 'edit',
          description: "Edit a page's content from Markdown",
          fn: guarded(edit),
          write: true,
          positional: [PAGE_ID],
          options: [content(), jsonOut(), notionVersion()],
        }),
        new CLISpec({
          name: 'trash',
          description: 'Trash a page',
          fn: guarded(trash),
          write: true,
          positional: [PAGE_ID],
          options: [
            new Option({
              long: '--yes',
              type: 'bool',
              description: 'Skip the confirmation prompt',
            }),
            notionVersion(),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'whoami',
      description: 'Show the authenticated Notion user',
      fn: guarded(whoami),
      options: [jsonOut(), plain(), notionVersion()],
    }),
  ],
})

registerCliSpec(NTN)
