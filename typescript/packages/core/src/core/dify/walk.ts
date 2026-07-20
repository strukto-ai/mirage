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

import { rekey } from '../../utils/key_prefix.ts'
import type { DifyAccessor } from '../../accessor/dify.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { resolvePath, type ResolvedDifyPath } from './path.ts'
import { readdir } from './readdir.ts'

export interface WalkOptions {
  includeRoot?: boolean
  maxDepth?: number | null
  stripPrefix?: boolean
  ignoreMissing?: boolean
  depth?: number
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function walk(
  accessor: DifyAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options: WalkOptions = {},
): Promise<string[]> {
  const includeRoot = options.includeRoot ?? false
  const maxDepth = options.maxDepth ?? null
  const stripPrefix = options.stripPrefix ?? false
  const ignoreMissing = options.ignoreMissing ?? false
  const depth = options.depth ?? 0

  let resolved: ResolvedDifyPath
  try {
    resolved = await resolvePath(accessor, path, index)
  } catch (err) {
    if (ignoreMissing && isMissing(err)) return []
    throw err
  }

  const current = stripPrefix ? path.mountPath : path.virtual
  const results = includeRoot ? [current] : []
  if (!resolved.isDir || (maxDepth !== null && depth >= maxDepth)) {
    return results
  }

  let children: string[]
  try {
    children = await readdir(accessor, path, index)
  } catch (err) {
    if (ignoreMissing && isMissing(err)) return results
    throw err
  }

  for (const child of children) {
    const childPath = PathSpec.fromStrPath(child, rekey(path.virtual, path.resourcePath, child))
    results.push(
      ...(await walk(accessor, childPath, index, {
        includeRoot: true,
        maxDepth,
        stripPrefix,
        ignoreMissing,
        depth: depth + 1,
      })),
    )
  }
  return results
}
