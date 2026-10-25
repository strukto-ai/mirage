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

import type { Accessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import type { JsonValue, PathSpec, SearchQuery } from '../../../../types.ts'
import { defaultPaths } from '../../../builtin/utils/paths.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { Argument, CommandSpec } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'

/**
 * The options a line gives the mount's search, only those it names. The
 * mount answers an absent one with its own default and refuses a value it
 * cannot take, before it sends any request; a `--top-k` below 1 is a usage
 * error. Mirrors Python's `search_options`.
 */
export function searchOptions(fl: FlagView): Record<string, JsonValue> {
  const options: Record<string, JsonValue> = {}
  const topK = fl.asInt('top_k')
  if (topK !== undefined) {
    if (topK < 1) throw new UsageError('search: top-k must be positive')
    options.top_k = topK
  }
  const threshold = fl.asFloat('threshold')
  if (threshold !== undefined) options.threshold = threshold
  const method = fl.asStr('method')
  if (method !== undefined) options.method = method
  return options
}

/**
 * Rank the records under every scope for one query and print each hit's
 * record: one search through the dispatcher, the scopes after the first
 * riding along as `scopes`, which ranks them as one where the mount serving
 * them all ranks a batch, and searches each and joins the hits in scope
 * order otherwise. A declined query fails rather than reading as no
 * matches. Mirrors Python's `search`.
 */
export async function search(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const text = texts[0]
  if (text === undefined || text === '') throw new UsageError('search: query is required')
  if (ctx.vfs === undefined) throw new Error('no workspace files')
  const query: SearchQuery = {
    query: text,
    options: searchOptions(new FlagView(ctx.flags, ctx.spec)),
  }
  const [first, ...scopes] = defaultPaths(paths, ctx.cwd.virtual)
  if (first === undefined) throw new Error('no scope to search')
  const [answer] = await ctx.vfs.dispatch(
    'search',
    first,
    [query],
    scopes.length > 0 ? { scopes } : {},
  )
  if (answer === null) throw new Error('the mount declined the query')
  const records = answer as [string, string][]
  const out = records.map(([, record]) => `${record}\n`).join('')
  return [new TextEncoder().encode(out), new IOResult()]
}

export const SEARCH = new CLI({
  spec: new CommandSpec({
    name: 'search',
    description: 'Rank the records of a search mount for a query',
    arguments: [
      new Argument('--method', {
        help: 'Ranking method: semantic (default); Dify also takes fulltext, hybrid and keyword',
      }),
      new Argument('--top-k', {
        type: 'int',
        help: "Most hits to print; the mount's default when absent",
      }),
      new Argument('--threshold', {
        type: 'float',
        help: 'Lowest score a hit needs; 0 keeps every hit',
      }),
      new Argument('query', { nargs: '?', help: 'Text to rank records by' }),
      new Argument('paths', {
        type: 'path',
        nargs: '*',
        help: 'Folders or files to search; the working directory when none is given',
      }),
    ],
  }),
  handlers: { '': new CLIHandler({ fn: search }) },
})
