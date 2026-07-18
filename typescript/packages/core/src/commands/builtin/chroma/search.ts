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
import type { ChromaAccessor } from '../../../accessor/chroma.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { CHROMA_IO } from './io.ts'
import { searchSegments } from '../../../core/chroma/search.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { ResourceName } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { defaultPaths } from '../utils/operands.ts'

const resolveGlob = resolveGlobOf(CHROMA_IO)

const ENC = new TextEncoder()

function isMountRoot(path: PathSpec): boolean {
  let root =
    mountPrefixOf(path.virtual, path.resourcePath) !== ''
      ? rstripSlash(mountPrefixOf(path.virtual, path.resourcePath))
      : '/'
  root = root !== '' ? root : '/'
  const value = rstripSlash(path.virtual) !== '' ? rstripSlash(path.virtual) : '/'
  return value === '/' || value === root
}

async function searchCommand(
  accessor: ChromaAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = texts[0]
  if (query === undefined || query === '') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('search: query is required\n') })]
  }
  const index = opts.index ?? undefined
  const targetPaths = defaultPaths(paths, opts.cwd, opts.mountPrefix ?? '')
  const mountPrefix =
    (targetPaths[0] === undefined
      ? undefined
      : mountPrefixOf(targetPaths[0].virtual, targetPaths[0].resourcePath)) ?? ''
  const resolvedPaths = targetPaths.some(isMountRoot)
    ? []
    : await resolveGlob(accessor, targetPaths, index)
  const topK = typeof opts.flags.top_k === 'string' ? Number.parseInt(opts.flags.top_k, 10) : 10
  try {
    const out = await searchSegments(accessor, query, resolvedPaths, index, topK, mountPrefix)
    return [out, new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}

export const CHROMA_SEARCH = command({
  name: 'chroma-query',
  resource: ResourceName.CHROMA,
  spec: specOf('search'),
  fn: searchCommand,
})
