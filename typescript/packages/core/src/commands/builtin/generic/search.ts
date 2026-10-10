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
import type { JsonValue, PathSpec, VFSName } from '../../../types.ts'
import { searchResources } from '../../../vfs/search.ts'
import { command, type CommandFnResult, type CommandOpts, type Command } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { defaultPaths } from '../utils/paths.ts'
import { pathsScoped } from '../../../view/namespace_view.ts'

const ENC = new TextEncoder()

/**
 * A ranked store's search options, read off the flags: the store answers
 * `--top-k` (its own default when absent) and `--threshold`; any method but
 * `semantic` is a usage error. Mirrors Python's `semantic_options`.
 */
export function semanticOptions(fl: FlagView): Record<string, JsonValue> {
  const method = fl.asStr('method') ?? 'semantic'
  if (method !== 'semantic') {
    throw new UsageError("search: only the 'semantic' method is supported")
  }
  const options: Record<string, JsonValue> = { method, threshold: fl.asFloat('threshold') ?? 0 }
  const topK = fl.asInt('top_k')
  if (topK !== undefined) options.top_k = topK
  return options
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
    accessor: Accessor,
    paths: PathSpec[],
    texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> {
    const query = texts[0]
    if (query === undefined || query === '') throw new UsageError('search: query is required')
    const fl = new FlagView(opts.flags, specOf('search'))
    const targets = defaultPaths(paths, opts.cwd, opts.mountPrefix ?? '')
    // A batch ranking answers for every scope in one call past the
    // dispatcher; where a hide or a path rule reaches the scopes each is
    // searched at the dispatcher, which declines one the view restricts.
    let capability = opts.io?.search
    if (capability !== undefined && pathsScoped(opts.ns, targets, opts.mountPrefix ?? '')) {
      capability = { ...capability }
      delete capability.searchMany
    }
    try {
      const out = await searchResources(
        capability,
        accessor,
        targets,
        { query, options: options(fl) },
        opts.index ?? undefined,
      )
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
