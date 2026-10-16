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

import { ListingCheckStore } from '@struktoai/mirage-core/cache/index/ram'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { HfHubError } from './client.ts'
import { refusalsDenied } from './lookup.ts'
import { headCommit, mountVersion } from './repo.ts'
import { fetchPath, rowOf } from './tree.ts'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * Stat one path in the repository.
 *
 * A path answers with its row, as its folder's listing names it. The gate's
 * check is handed no listed row, so it asks for the one path with one
 * paths-info request rather than walking the whole tree; its row carries the
 * oid a tree row does. Mirrors Python's `stat`.
 */
export async function stat(
  accessor: HfHubAccessor,
  pathSpec: PathSpec,
  entry?: FileStat | null,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const rel = stripSlash(pathSpec.mountPath)
  if (rel === '') {
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      fingerprint: await rootVersion(accessor, index),
    })
  }
  if (entry !== undefined && entry !== null) return entry
  if (!(index instanceof ListingCheckStore)) throw enoent(pathSpec.virtual)
  const found = (await refusalsDenied(pathSpec, () => fetchPath(accessor, rel))).get(rel)
  if (found === undefined) throw enoent(pathSpec.virtual)
  return rowOf(found, rel.slice(rel.lastIndexOf('/') + 1))
}

/**
 * The version of the whole mount: the head commit its revision is at.
 *
 * Only the gate's `ListingCheckStore` asks for it, with one small request.
 * Every other index (the mount's own, an undefined index) names no version
 * and reads nothing, neither the index nor the Hub, so a getattr of the root
 * never pays a check or a store round trip: nothing reads a root fingerprint
 * off a mount-view stat. Nothing here refills the index or loads the tree: a
 * refused head names no version rather than falling into a lookup.
 *
 * Mirrors Python's `_root_version`.
 */
async function rootVersion(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
): Promise<string | null> {
  if (!(index instanceof ListingCheckStore)) return null
  try {
    return mountVersion(await headCommit(accessor), accessor.keyPrefix)
  } catch (err) {
    // A Hub that refuses the head gives no answer about the version; a
    // transport failure or anything else propagates.
    if (!(err instanceof HfHubError)) throw err
    console.warn(`head of ${accessor.repoId} not answered: ${String(err)}`)
    return null
  }
}
