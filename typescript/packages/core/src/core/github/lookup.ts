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
import { isEnoent } from '../../errors/fs.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { readdirUnlocked } from './readdir.ts'
import { pointRow, refillSnapshot } from './tree.ts'
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
 * Where one path sits, the same for a stat and a read: the mount prefix ('' for
 * a root mount), the path as the mount sees it with no slash at either end (''
 * for the mount root), and the mount-absolute key the index files it under.
 *
 * Mirrors Python's `locate`.
 */
export function locate(path: PathSpec): { prefix: string; rel: string; key: string } {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let at = path.virtual
  if (prefix !== '' && at.startsWith(prefix)) at = at.slice(prefix.length) || '/'
  const rel = stripSlash(at)
  return { prefix, rel, key: `${rstripSlash(prefix)}/${rel}` }
}

/**
 * Resolve one mount-absolute key through the mount's listing.
 *
 * The parent's current listing is what establishes membership: an entry row
 * survives invalidation and a replacement listing, so a key it no longer
 * names is absent even when its old row is still there. The parent is
 * filled first if the index holds no listing for it. A listed name with no
 * row refills once unless `recoverEvicted` is false, which the retry passes.
 *
 * Mirrors Python's `lookup`.
 */
export async function lookup(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
  recoverEvicted = true,
): Promise<Found> {
  if (index === undefined) return ABSENT
  return withIndexLock(index, rootOf(prefix), async () => {
    if (!(await listed(accessor, index, prefix, key))) return ABSENT
    const entry = (await index.get(key)).entry ?? null
    if (entry !== null) return { entry }
    // A clear can race the read and another op reseed the index after it;
    // read the row once more before taking the miss as an eviction.
    const again = (await index.get(key)).entry ?? null
    if (again !== null || !recoverEvicted) return { entry: again }
    // Eviction can drop a row its listing still names. The store serves the
    // listing regardless, so the miss is checked here, on demand: refill once,
    // as for an expired listing, and resolve the key again.
    if (accessor.truncated) {
      await index.invalidateDir(key.slice(0, key.lastIndexOf('/')) || '/')
    } else {
      await refillSnapshot(accessor, index, prefix)
    }
    if (!(await listed(accessor, index, prefix, key))) return ABSENT
    return { entry: (await index.get(key)).entry ?? null }
  })
}

/** Whether the parent's current listing names `key`; the caller holds the lock. */
async function listed(
  accessor: GitHubAccessor,
  index: IndexCacheStore,
  prefix: string,
  key: string,
): Promise<boolean> {
  const parent = key.slice(0, key.lastIndexOf('/')) || '/'
  try {
    const children = await readdirUnlocked(
      accessor,
      new PathSpec({
        virtual: parent,
        directory: parent,
        resolved: false,
        vfsPath: mountKey(parent, prefix),
      }),
      index,
    )
    return children.includes(key)
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

/**
 * `lookup`, asked once more when it finds nothing.
 *
 * A `read: fresh` verdict clears the mount index without taking its lock,
 * and one landing mid-lookup leaves a miss that only says the store was
 * emptied. Read as absence, that miss reaches `onEnoent` through a
 * dispatcher door and drops the path's overlay for good. The second lookup
 * refills a cleared index, or reads the one another op reseeded meanwhile,
 * so a miss is absent only when both agree. A genuine miss costs one more
 * index read and no request, since the first lookup left the listing that
 * answers the second; only a missing directory in a truncated tree is
 * walked twice. The second lookup does not refill for a listed name with no
 * row: the first already did, so a row the refill did not bring back is
 * absent after one refill, not two. Two clears inside one call can still
 * produce a false miss, as in hf.
 *
 * Mirrors Python's `lookup_retrying`.
 */
export async function lookupRetrying(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
): Promise<Found> {
  const found = await lookup(accessor, index, prefix, key)
  if (found.entry !== null || index === undefined) return found
  return lookup(accessor, index, prefix, key, false)
}

/**
 * Answer one path with one directory listing, where a walk would be waste.
 *
 * Taken whenever the index holds no listing at all: the throwaway store
 * reconcile and the drift check stat through, a mount index a verdict just
 * cleared, or one nothing has listed into yet (`create` fetches the tree but
 * seeds no index). A live or expired index keeps its own answer, and its root
 * is read first, so a live index answers without a request.
 *
 * Nothing is written back: one directory is not the mount's listing, and
 * seeding it would make every other path read as absent. The next readdir or
 * read fills the index from the whole tree. A parent it cannot see, and a
 * truncated listing without the name, are no answer.
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
  if (root.status !== LookupStatus.NOT_FOUND) return null
  const answer = await pointRow(accessor, rel)
  if (answer === null) return null
  if (answer.entry === null) return answer.truncated ? null : ABSENT
  return { entry: indexEntryFromTree(answer.entry) }
}
