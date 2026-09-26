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

import type { GitHubAccessor } from '../../accessor/github.ts'
import { LookupStatus, type IndexEntry } from '../../cache/index/config.ts'
import { withIndexLock } from '../../cache/index/lock.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { isEnoent } from '../../utils/errors.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { readdirUnlocked } from './readdir.ts'
import { pointRow } from './tree.ts'
import { indexEntryFromTree } from './tree_entry.ts'

/** What sits at one mount-absolute key; `entry` is null when nothing is. */
export interface Found {
  entry: IndexEntry | null
}

const ABSENT: Readonly<Found> = Object.freeze({ entry: null })

/** The mount root's key, whose listing tells a live index from not. */
export function rootOf(prefix: string): string {
  return rstripSlash(prefix) || '/'
}

/**
 * Resolve one mount-absolute key through the mount's listing.
 *
 * The parent's current listing is what establishes membership: an entry row
 * survives invalidation and a replacement listing, so a key it no longer
 * names is absent even when its old row is still there. The parent is
 * filled first if the index holds no listing for it.
 *
 * Mirrors Python's `lookup`.
 */
export async function lookup(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
): Promise<Found> {
  if (index === undefined) return ABSENT
  return withIndexLock(index, rootOf(prefix), async () => {
    const parent = key.slice(0, key.lastIndexOf('/')) || '/'
    let children: string[]
    try {
      children = await readdirUnlocked(
        accessor,
        new PathSpec({
          virtual: parent,
          directory: parent,
          resolved: false,
          vfsPath: mountKey(parent, prefix),
        }),
        index,
      )
    } catch (error) {
      if (isEnoent(error)) return ABSENT
      throw error
    }
    if (!children.includes(key)) return ABSENT
    const result = await index.get(key)
    return { entry: result.entry ?? null }
  })
}

/**
 * `lookup`, asked once more if the index was cleared under it.
 *
 * A `read: fresh` verdict clears the mount index without taking its lock,
 * and one landing mid-lookup leaves a miss that only says the store is
 * empty. Read as absence, that miss reaches `onOpMissing` through a
 * dispatcher door and drops the path's overlay for good. Two signs tell it
 * from a real one: the root listing is gone (a live index always has one),
 * or the accessor wrote a listing while the lookup ran, which is a clear
 * followed by a concurrent reseed.
 *
 * Mirrors Python's `lookup_retrying`.
 */
export async function lookupRetrying(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
): Promise<Found> {
  const refills = accessor.refills
  const found = await lookup(accessor, index, prefix, key)
  if (found.entry !== null || index === undefined) return found
  const root = await index.listDir(rootOf(prefix))
  if (root.status !== LookupStatus.NOT_FOUND && accessor.refills === refills) return found
  return lookup(accessor, index, prefix, key)
}

/**
 * Answer one path with one directory listing, where a walk would be waste.
 *
 * Taken only when the index holds no listing at all while the mount has
 * listed before: the throwaway store reconcile and the drift check stat
 * through, or a mount index a verdict just cleared. A mount that never
 * listed seeds through its tree as it always has -- `create` fetches the
 * tree but seeds no index, so it counts as not listed -- and a live or
 * expired index keeps its own answer. The root is read before the accessor.
 *
 * Nothing is written back: one directory is not the mount's listing, and
 * seeding it would make every other path read as absent. A parent it cannot
 * see, and a truncated listing without the name, are no answer.
 *
 * Mirrors Python's `point_lookup`.
 */
export async function pointLookup(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  rel: string,
): Promise<Found | null> {
  if (index === undefined) return null
  const root = await index.listDir(rootOf(prefix))
  if (root.status !== LookupStatus.NOT_FOUND || accessor.refills === 0) return null
  const answer = await pointRow(accessor, rel)
  if (answer === null) return null
  if (answer.entry === null) return answer.truncated ? null : ABSENT
  return { entry: indexEntryFromTree(answer.entry) }
}
