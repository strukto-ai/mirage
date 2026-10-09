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
import { CommandSpec } from '../../../spec/types.ts'
import { CLI } from '../../types.ts'
import { CLIHandler } from '../../types.ts'

import { NotionConfigSchema } from '../../../../core/notion/config.ts'

import { Argument, UsageStyle } from '../../../spec/types.ts'
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
const PAGE_ID = new Argument('PAGE_ID')
const DATA_SOURCE_ID = new Argument('ID_OR_URL')
const DATABASE_ID = new Argument('ID')
const API_PATH = new Argument('PATH', { nargs: '*' })
const jsonOut = (): Argument =>
  new Argument('--json', { action: 'store_true', help: 'Output the raw API response as JSON' })
const plain = (): Argument =>
  new Argument('--plain', {
    action: 'store_true',
    help: 'Output as tab-separated values with no headers',
  })
// NOTION_API_VERSION is upstream's own environment fallback, and naming it
// here is what makes the flag real: the executor fills the value from the
// session, so a leaf reads one flag rather than a flag and a fallback, and a
// usage line counts the option as supplied the way clap does.
const notionVersion = (): Argument =>
  new Argument('--notion-version', {
    metavar: 'VERSION',
    env: 'NOTION_API_VERSION',
    help: 'Override the Notion-Version header',
  })
const content = (): Argument =>
  new Argument('--content', { help: 'Markdown body (also read from stdin)' })

// The ntn program tree, matching the official Notion CLI's grammar verb for
// verb: ids are positional, `pages get` renders Markdown with a frontmatter
// title, and the REST surface that has no typed verb is reached through
// `ntn api` exactly as upstream reaches it. There is no `ntn blocks`/`ntn
// comments`/`ntn search`; those are `ntn api v1/blocks/...`, `ntn api
// v1/comments` and `ntn api v1/search`. Upstream's interactive and deploy
// verbs (`login`, `logout`, `update`, `workers`, `notion-as-code`, `doctor`,
// `files`) are out of scope for a virtualized CLI. Install with a NotionConfig.
export const NTN = new CLI({
  spec: new CommandSpec({
    name: 'ntn',
    description: 'Notion CLI (Beta)',
    usageStyle: UsageStyle.CLAP,
    subcommands: [
      new CommandSpec({
        name: 'api',
        description: 'Call the public Notion API (beta)',
        arguments: [
          new Argument(['-d', '--data'], { help: 'Use a JSON string as the request body' }),
          new Argument(['-X', '--method'], { help: 'Override the inferred HTTP method' }),
          notionVersion(),
          API_PATH,
        ],
      }),
      new CommandSpec({
        name: 'auth',
        description: 'Inspect authentication credentials',
        subcommands: [
          new CommandSpec({ name: 'token', description: 'Print the current authentication token' }),
        ],
      }),
      new CommandSpec({
        name: 'datasources',
        description: 'Manage data sources',
        subcommands: [
          new CommandSpec({
            name: 'query',
            description: 'Query pages in a data source',
            arguments: [
              new Argument('--limit', { type: 'int', help: 'Maximum rows to return' }),
              new Argument('--start-cursor', { help: 'Cursor to resume from' }),
              new Argument(['-s', '--sort'], {
                action: 'append',
                metavar: 'SPEC',
                help: "'<property> [asc|desc]'",
              }),
              new Argument('--filter', { metavar: 'JSON', help: 'Filter as a JSON object' }),
              new Argument('--filter-file', {
                type: 'path',
                metavar: 'PATH',
                help: 'Read the filter from a file',
              }),
              jsonOut(),
              plain(),
              notionVersion(),
              DATA_SOURCE_ID,
            ],
          }),
          new CommandSpec({
            name: 'resolve',
            description: 'Resolve a Notion database ID to its data source IDs',
            arguments: [jsonOut(), notionVersion(), DATABASE_ID],
          }),
        ],
      }),
      new CommandSpec({
        name: 'pages',
        description: 'Manage pages',
        subcommands: [
          new CommandSpec({
            name: 'get',
            description: 'Retrieve a page as Markdown',
            arguments: [jsonOut(), notionVersion(), PAGE_ID],
          }),
          new CommandSpec({
            name: 'create',
            description: 'Create a page from Markdown content',
            arguments: [
              content(),
              new Argument('--parent', { help: 'page:<id>, database:<id>, or data-source:<id>' }),
              jsonOut(),
              notionVersion(),
            ],
          }),
          new CommandSpec({
            name: 'edit',
            description: "Edit a page's content from Markdown",
            arguments: [content(), jsonOut(), notionVersion(), PAGE_ID],
          }),
          new CommandSpec({
            name: 'trash',
            description: 'Trash a page',
            arguments: [
              new Argument('--yes', { action: 'store_true', help: 'Skip the confirmation prompt' }),
              notionVersion(),
              PAGE_ID,
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'whoami',
        description: 'Show the authenticated Notion user',
        arguments: [jsonOut(), plain(), notionVersion()],
      }),
    ],
  }),
  handlers: {
    api: new CLIHandler({ fn: guarded(api), write: true }),
    'auth token': new CLIHandler({ fn: guarded(token) }),
    'datasources query': new CLIHandler({ fn: guarded(query) }),
    'datasources resolve': new CLIHandler({ fn: guarded(resolve) }),
    'pages get': new CLIHandler({ fn: guarded(get) }),
    'pages create': new CLIHandler({ fn: guarded(create), write: true }),
    'pages edit': new CLIHandler({ fn: guarded(edit), write: true }),
    'pages trash': new CLIHandler({ fn: guarded(trash), write: true }),
    whoami: new CLIHandler({ fn: guarded(whoami) }),
  },
  configModel: NotionConfigSchema,
})
