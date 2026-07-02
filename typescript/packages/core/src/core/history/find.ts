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

import type { HistoryAccessor } from '../../accessor/history.ts'
import { buildTree, type FindEntry, keep } from '../../commands/builtin/findEval.ts'
import type { FindOptions } from '../ram/find.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { PathSpec } from '../../types.ts'
import { read, VIEW_KEYS, VIEW_NAME } from './read.ts'

/**
 * find_core over the single-file view: match the view or nothing. The
 * view is one virtual file at depth 0 of the mount; predicates are
 * evaluated through the shared buildTree/keep machinery, so an
 * expression `tree` and the flag options behave identically to the
 * real-tree backends.
 */
export async function find(
  accessor: HistoryAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  if (!VIEW_KEYS.includes(stripSlash(path.mountPath))) return []
  if (options.maxDepth !== null && options.maxDepth !== undefined && options.maxDepth < 0) {
    return []
  }
  let isEmpty: boolean | null = null
  if (
    (options.minSize !== null && options.minSize !== undefined) ||
    (options.maxSize !== null && options.maxSize !== undefined) ||
    options.empty === true
  ) {
    const size = (await read(accessor, path)).byteLength
    if (options.minSize !== null && options.minSize !== undefined && size < options.minSize) {
      return []
    }
    if (options.maxSize !== null && options.maxSize !== undefined && size > options.maxSize) {
      return []
    }
    isEmpty = size === 0
  }
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  const entry: FindEntry = {
    key: path.virtual,
    name: VIEW_NAME,
    kind: 'f',
    depth: 0,
    isEmpty,
  }
  if (!keep(entry, tree, options.minDepth)) return []
  return ['']
}
