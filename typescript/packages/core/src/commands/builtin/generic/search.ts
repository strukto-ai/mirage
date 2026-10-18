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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { JsonValue, PathSpec, VFSName } from '../../../types.ts'
import type { SearchQuery } from '../../../vfs/types.ts'
import { command, type CommandFnResult, type Context, type Command } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { defaultPaths } from '../utils/paths.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'

const ENC = new TextEncoder()

/**
 * A ranked store's search options, read off the flags: the store answers
 * `--top-k` (its own default when absent) and `--threshold`; any method but
 * `semantic` is a usage error. Mirrors Python's `semantic_options`.
 */
export function semanticOptions(fl: FlagView): Record<string, JsonValue> {
  const method = fl.asStr('method', 'semantic')
  if (method !== 'semantic') {
    throw new UsageError("search: only the 'semantic' method is supported")
  }
  const options: Record<string, JsonValue> = { method, threshold: fl.asFloat('threshold') ?? 0 }
  const topK = fl.asInt('top_k')
  if (topK !== undefined) options.top_k = topK
  return options
}

/**
 * Rank `paths` for `query` at the dispatcher: one `search` over every scope,
 * which the dispatcher answers in one batch where the backend ranks several
 * scopes together (`searchMany`) and scope by scope otherwise. Each hit's
 * record is printed, one per line; a declined query fails rather than
 * reading as no matches.
 */
export async function searchResources(
  dispatch: DispatchFn,
  paths: PathSpec[],
  query: SearchQuery,
): Promise<Uint8Array> {
  const [first, ...scopes] = paths
  if (first === undefined) throw new Error('search: at least one scope is required')
  const [answer] = await dispatch('search', first, [query], scopes.length > 0 ? { scopes } : {})
  if (answer === null) throw new Error('search: backend declined the query')
  const records = answer as [string, string][]
  return new TextEncoder().encode(
    records.length === 0 ? '' : records.map(([, record]) => record).join('\n') + '\n',
  )
}

/**
 * Build `NAME QUERY [PATH...]` over a backend's native search. A missing
 * query is a usage error; the backend reads the rest of its options off the
 * flags. Mirrors `make_search` in `commands/builtin/generic/search.py`.
 */
export function makeSearch(
  vfs: VFSName,
  options: (fl: FlagView) => Record<string, JsonValue> = semanticOptions,
  { name = 'search' }: { name?: string } = {},
): Command[] {
  async function search(
    _accessor: Accessor,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
  ): Promise<CommandFnResult> {
    const query = texts[0]
    if (query === undefined || query === '') throw new UsageError('search: query is required')
    const fl = new FlagView(ctx.flags, specOf('search'))
    try {
      const scopes = defaultPaths(
        paths,
        ctx.cwd.virtual,
        mountPrefixOf(ctx.cwd.virtual, ctx.cwd.vfsPath),
      )
      const asked = { query, options: options(fl) }
      if (ctx.vfs === undefined) throw new Error('search: no workspace files')
      const out = await searchResources(ctx.vfs.dispatch, scopes, asked)
      return [out, new IOResult()]
    } catch (err) {
      if (err instanceof UsageError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
  }
  return command({
    name,
    vfs,
    spec: specOf('search'),
    fn: search,
  })
}
