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

import type { DirListing, PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { refusalsDenied } from './lookup.ts'
import { headCommit, mountVersion } from './repo.ts'
import { fetchTree, treeListing } from './tree.ts'

/**
 * A folder's listing, with every folder below it as seeds.
 *
 * One paged walk answers the whole repository, at the commit the revision's
 * head names: the head first, and the tree walked at that commit, so the
 * version the listing carries is the one its rows are at, never a later one a
 * commit landing between the two requests would give. A Hub that names no
 * head walks the branch and versions nothing. Mirrors Python's `readdir`.
 */
export async function readdir(accessor: HfHubAccessor, pathSpec: PathSpec): Promise<DirListing> {
  const rel = stripSlash((pathSpec.pattern === null ? pathSpec : pathSpec.dir).mountPath)
  const [head, tree] = await refusalsDenied(pathSpec, async () => {
    const found = (await headCommit(accessor)) || null
    return [found, await fetchTree(accessor, found ?? undefined)] as const
  })
  return treeListing(tree, rel, mountVersion(head, accessor.keyPrefix), pathSpec.virtual)
}
