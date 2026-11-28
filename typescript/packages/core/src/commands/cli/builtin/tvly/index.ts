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

// The tvly program tree follows tvly 1.0.2's src/program.ts verb for verb
// (MIT; see licenses/third_party/tavily-cli.txt). Its setup verbs (`init`,
// `login`, `logout`, `setup mcp`, `set-default`, `update`) and the interactive
// shell change the machine tvly runs on, which a workspace has none of, so
// they are out of scope; the install carries the key. Install with a
// TavilyConfig.

import { TavilyAccessor } from '../../../../accessor/tavily.ts'
import { TavilyConfig } from '../../../../core/tavily/config.ts'
import { Argument, CommandSpec, UsageStyle } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'
import { auth } from './auth.ts'
import { extract } from './extract.ts'
import { guarded } from './failure.ts'
import { research } from './research.ts'
import { SEARCH_FLAGS, type SearchFlag, search } from './search.ts'
import { crawl, mapSite } from './site.ts'

const JSON_FLAG = new Argument('--json', {
  action: 'store_true',
  help: 'Output as JSON (for agents and scripts)',
})
const OUTPUT = new Argument(['-o', '--output'], {
  type: 'path',
  nargs: '?',
  metavar: 'file',
  help: 'Save the full JSON response to this file. With no value, save it under .tavily/ with a generated name.',
})
const CLIENT_NAME = new Argument('--client-name', {
  metavar: 'name',
  env: 'TAVILY_CLIENT_NAME',
  help: 'Set optional client_name for request attribution.',
})
const TIMEOUT = new Argument('--timeout', {
  metavar: 'seconds',
  help: 'Max wait time in seconds (10-150).',
})
const EXTRACT_DEPTH = new Argument('--extract-depth', {
  metavar: 'depth',
  help: 'Extraction depth: basic or advanced.',
})
const FORMAT = new Argument('--format', {
  metavar: 'format',
  help: 'Output format: markdown or text.',
})
const INCLUDE_IMAGES = new Argument('--include-images', {
  action: 'store_true',
  help: 'Include image URLs.',
})

function searchArgument(flag: SearchFlag): Argument {
  if (flag.kind === 'switch') {
    return new Argument(flag.flag, { action: 'store_true', help: flag.help })
  }
  if (flag.kind === 'optional') {
    return new Argument(flag.flag, { nargs: '?', metavar: 'value', help: flag.help })
  }
  const metavar = flag.kind === 'list' ? 'list' : flag.kind === 'value' ? 'value' : 'n'
  return new Argument(flag.flag, { metavar, help: flag.help })
}

function siteArguments(verb: string, limitHelp: string): Argument[] {
  const guide = verb === 'crawl' ? 'the crawler' : 'URL discovery'
  return [
    new Argument('--max-depth', {
      metavar: 'n',
      help: `Levels deep to ${verb} (1-5, default: 1).`,
    }),
    new Argument('--max-breadth', { metavar: 'n', help: 'Links per page (default: 20).' }),
    new Argument('--limit', { metavar: 'n', help: limitHelp }),
    new Argument('--instructions', {
      metavar: 'text',
      help: `Natural language guidance for ${guide}.`,
    }),
  ]
}

const SITE_FILTERS: readonly Argument[] = [
  new Argument('--select-paths', {
    metavar: 'patterns',
    help: 'Comma-separated regex patterns for paths to include.',
  }),
  new Argument('--exclude-paths', {
    metavar: 'patterns',
    help: 'Comma-separated regex patterns for paths to exclude.',
  }),
  new Argument('--select-domains', {
    metavar: 'patterns',
    help: 'Comma-separated regex patterns for domains to include.',
  }),
  new Argument('--exclude-domains', {
    metavar: 'patterns',
    help: 'Comma-separated regex patterns for domains to exclude.',
  }),
  new Argument('--allow-external', {
    action: 'store_true',
    help: 'Include external domain links.',
  }),
  new Argument('--no-external', {
    action: 'store_true',
    help: 'Leave out external domain links.',
  }),
  TIMEOUT,
]

export const TVLY = new CLI({
  spec: new CommandSpec({
    name: 'tvly',
    description: 'Tavily CLI: search, extract, crawl, map, and research from the command line.',
    usageStyle: UsageStyle.COMMANDER,
    arguments: [JSON_FLAG],
    subcommands: [
      new CommandSpec({
        name: 'auth',
        description: 'Check authentication status.',
        arguments: [JSON_FLAG],
      }),
      new CommandSpec({
        name: 'search',
        description: 'Search the web using Tavily.',
        arguments: [
          new Argument('queries', {
            nargs: '*',
            help: 'One or more search queries (up to 5), run in parallel with the same options. Use - to read a single query from stdin.',
          }),
          ...SEARCH_FLAGS.map(searchArgument),
          new Argument('--max-chars', {
            metavar: 'n',
            help: "Characters of each result's content to print (default 600, shared across queries: 300 each for 2, 200 for 3); 0 prints it whole. --json and -o files keep it whole.",
          }),
          OUTPUT,
          CLIENT_NAME,
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'extract',
        description: 'Extract content from one or more URLs.',
        arguments: [
          new Argument('urls', { nargs: '*', help: 'URLs to extract (max 20).' }),
          new Argument('--query', {
            metavar: 'query',
            help: 'Rerank chunks by relevance to this query.',
          }),
          new Argument('--chunks-per-source', {
            metavar: 'n',
            help: 'Chunks per source (1-5, requires --query).',
          }),
          EXTRACT_DEPTH,
          FORMAT,
          INCLUDE_IMAGES,
          new Argument('--timeout', {
            metavar: 'seconds',
            help: 'Max wait time in seconds (1-60).',
          }),
          OUTPUT,
          CLIENT_NAME,
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'crawl',
        description: 'Crawl a website starting from URL.',
        arguments: [
          new Argument('url', {
            nargs: '*',
            help: 'Where to start; returns full content for each discovered page.',
          }),
          ...siteArguments('crawl', 'Total pages cap (default: 50).'),
          new Argument('--chunks-per-source', {
            metavar: 'n',
            help: 'Chunks per page (1-5, requires --instructions).',
          }),
          EXTRACT_DEPTH,
          FORMAT,
          ...SITE_FILTERS,
          new Argument('--include-images', { action: 'store_true', help: 'Include images.' }),
          new Argument('--output-dir', {
            type: 'path',
            metavar: 'dir',
            help: 'Save each page as a .md file in this directory.',
          }),
          OUTPUT,
          CLIENT_NAME,
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'map',
        description: 'Discover all URLs on a website (no content extraction).',
        arguments: [
          new Argument('url', { nargs: '*', help: 'Where to start; returns the URLs found.' }),
          ...siteArguments('map', 'Maximum URLs to discover (default: 50).'),
          ...SITE_FILTERS,
          OUTPUT,
          CLIENT_NAME,
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'research',
        description:
          'Deep research: run a task, or check one with `research status <id>` or wait for it with `research poll <id>`.',
        arguments: [
          new Argument('words', {
            nargs: '*',
            metavar: 'query',
            help: 'The research topic, or "status"/"poll" and a request ID. Use "-" to read the topic from stdin.',
          }),
          new Argument('--model', {
            metavar: 'model',
            help: 'Research model: mini, pro or auto (default).',
          }),
          new Argument('--no-wait', {
            action: 'store_true',
            help: 'Return request_id immediately without waiting.',
          }),
          new Argument('--stream', { action: 'store_true', help: 'Stream results in real-time.' }),
          new Argument('--output-schema', {
            type: 'path',
            metavar: 'file',
            help: 'Path to JSON schema file for structured output.',
          }),
          new Argument('--citation-format', {
            metavar: 'format',
            help: 'Citation format: numbered, mla, apa or chicago.',
          }),
          OUTPUT,
          new Argument('--poll-interval', {
            metavar: 'n',
            help: 'Seconds between status checks (default: 10).',
          }),
          new Argument('--timeout', { metavar: 'n', help: 'Max seconds to wait (default: 600).' }),
          CLIENT_NAME,
          JSON_FLAG,
        ],
      }),
    ],
  }),
  handlers: {
    auth: new CLIHandler({ fn: guarded(auth) }),
    search: new CLIHandler({ fn: guarded(search), writeWhen: ['--output'] }),
    extract: new CLIHandler({ fn: guarded(extract), writeWhen: ['--output'] }),
    crawl: new CLIHandler({ fn: guarded(crawl), writeWhen: ['--output', '--output-dir'] }),
    map: new CLIHandler({ fn: guarded(mapSite), writeWhen: ['--output'] }),
    research: new CLIHandler({ fn: guarded(research), writeWhen: ['--output'] }),
  },
  configModel: TavilyConfig,
  accessor: (config) => new TavilyAccessor(config as TavilyConfig),
})
