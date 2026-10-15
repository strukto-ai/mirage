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

import type { Accessor } from '../../accessor/base.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { hasGlobPrefix } from '../../utils/glob_walk.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { makeReaddir as hierarchyReaddir, type Listed, type Lister } from '../hierarchy/readdir.ts'
import { ROOT, type ScopeMatch } from '../hierarchy/scope.ts'
import type { VectorTree } from './types.ts'

const PATTERN_KINDS = { [ROOT]: hasGlobPrefix, group: hasGlobPrefix }

/** Build a store's readdir: the catalog at the root, its own listing below. */
export function makeReaddir<A extends Accessor>(
  tree: VectorTree<A>,
): (accessor: A, path: PathSpec) => Promise<Listed> {
  async function listRoot(accessor: A, match: ScopeMatch): Promise<Listed | null> {
    if (tree.pinned(accessor) !== null) return tree.children(accessor, match)
    // Table names come from the catalog, not from a capped query, so a glob
    // here has nothing to narrow.
    const tables = await tree.listTables(accessor)
    return tables.map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
  }
  const listers: Record<string, Lister<A>> = { [ROOT]: listRoot, group: tree.children }
  const readdirFor = perAccessor((accessor: A) =>
    hierarchyReaddir(tree.detect(accessor), { listers, patternKinds: PATTERN_KINDS }),
  )
  return (accessor, path) => readdirFor(accessor)(accessor, path)
}
