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

import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { QdrantAccessor } from '../../../accessor/qdrant.ts'
import { searchRowsOutput } from '../../../core/qdrant/search.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { defaultPaths } from '../utils/operands.ts'

const ENC = new TextEncoder()

async function searchCommand(
  accessor: QdrantAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = texts[0]
  if (query === undefined || query === '') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('search: query is required\n') })]
  }
  const method = typeof opts.flags.method === 'string' ? opts.flags.method : 'semantic'
  if (method !== 'semantic') {
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode("search: only the 'semantic' method is supported\n"),
      }),
    ]
  }
  const target = defaultPaths(paths, opts.cwd)
  const mountPrefix =
    (target[0] === undefined
      ? undefined
      : mountPrefixOf(target[0].virtual, target[0].resourcePath)) ??
    opts.mountPrefix ??
    ''
  const topK =
    typeof opts.flags.top_k === 'string'
      ? parseInt(opts.flags.top_k, 10)
      : accessor.config.searchLimit
  const threshold = typeof opts.flags.threshold === 'string' ? Number(opts.flags.threshold) : 0
  try {
    const out = await searchRowsOutput(accessor, query, target, topK, threshold, mountPrefix)
    return [out, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}

export const QDRANT_SEARCH = command({
  name: 'search',
  resource: ResourceName.QDRANT,
  spec: specOf('search'),
  fn: searchCommand,
})
