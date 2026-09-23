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

import type { PathSpec, WalkEntry } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import { ListingDeltaHook } from '@struktoai/mirage-core/watch/delta'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { fetchTree } from './tree.ts'
import { isDirEntry } from './tree_entry.ts'

/**
 * One tree fetch feeding the generic listing differ.
 *
 * The Hub's listing endpoint is recursive, so a pull is one paged walk
 * whatever the repository's shape, and the fingerprint is the git object id:
 * git is content-addressed, so identical bytes carry an identical oid and a
 * rewrite that changed nothing correctly reports nothing.
 *
 * A mount reads one revision, so what this detects is that revision moving.
 * Nothing is reported while the branch sits still, however much is pushed
 * elsewhere in the repository.
 */
function hfHubWalk(accessor: HfHubAccessor) {
  return async function* walk(root: PathSpec): AsyncIterable<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const tree = await fetchTree(accessor)
    // The tree just fetched is exactly what the accessor holds, and find, du
    // and every no-index read consult it. Discarding it here would leave them
    // answering from the pre-pull listing, so a pull that reported a CREATE
    // would be followed by a find that could not see the file.
    accessor.tree = tree
    accessor.treeLoaded = true
    accessor.rowsCache = null
    const stem = root.mountPath.replace(/^\/+|\/+$/g, '')
    const base = stem === '' ? '' : `${stem}/`
    for (const entry of tree.values()) {
      if (base !== '' && !entry.path.startsWith(base)) continue
      const virtual =
        prefix === '' ? `/${entry.path}` : `${prefix.replace(/\/+$/, '')}/${entry.path}`
      if (isDirEntry(entry)) {
        yield { virtual, isDir: true, fingerprint: null }
        continue
      }
      yield {
        virtual,
        isDir: false,
        fingerprint: entry.oid,
        size: entry.size ?? null,
      }
    }
  }
}

export function buildDeltaHook(accessor: HfHubAccessor): DeltaHook {
  return new ListingDeltaHook(hfHubWalk(accessor))
}
