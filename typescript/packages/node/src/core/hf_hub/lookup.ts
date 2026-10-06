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

import { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import {
  LookupStatus,
  type ListResult,
  type LookupResult,
} from '@struktoai/mirage-core/cache/index/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eacces } from '@struktoai/mirage-core/errors/fs'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { HfHubError } from './client.ts'
import { ABSENT_STATUSES } from './constants.ts'
import { ensureLiveSnapshot, fetchPath, indexRows, localRows, refillSnapshot } from './tree.ts'
import { withIndexLock } from '@struktoai/mirage-core/cache/index/lock'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * What sits at one mount-absolute key.
 *
 * `entry` is null for a directory the tree implies but has no row of its own
 * for, which is why a caller must read `isDir` and `exists` rather than
 * testing `entry` for truth.
 */
export interface Found {
  entry: IndexEntry | null
  children: string[] | null
}

function exists(found: Found): boolean {
  return found.entry !== null || found.children !== null
}

export function isDir(found: Found): boolean {
  if (found.children !== null) return true
  return found.entry !== null && found.entry.resourceType === 'folder'
}

/**
 * Resolve one mount-absolute key against the mount's listing.
 *
 * The single place the two storage paths are told apart: a workspace mount
 * answers from its seeded index, and a mount built without one answers from
 * tables derived from the accessor's tree. Both are built by `indexRows`, so
 * they cannot disagree. A listed name with no row refills once unless
 * `recoverEvicted` is false, which the retry passes.
 */
export async function lookup(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
  recoverEvicted = true,
): Promise<Found> {
  if (index === undefined) {
    const { entries, children } = await localRows(accessor, prefix)
    return { entry: entries.get(key) ?? null, children: children.get(key) ?? null }
  }
  return withIndexLock(index, keyOf(prefix, ''), async () => {
    const root = keyOf(prefix, '')
    const parentKey = rstripSlash(key).replace(/\/[^/]+$/, '') || '/'
    let refilled = await ensureLiveSnapshot(accessor, index, prefix)
    let result = await index.get(key)
    let listing = await index.listDir(key)
    let parent = key === root ? listing : await index.listDir(parentKey)
    // The index is the whole listing rather than a cache in front of one, so an
    // *expired* answer means the tree aged out, not that the path is gone.
    // Refetch once and ask again; a miss against a live index is a real absence
    // and must not cost a tree fetch. A name the parent lists with no row of
    // its own was evicted, which the store does not check, so it is refilled
    // the same way.
    if (
      refilled === null &&
      (parent.status === LookupStatus.EXPIRED ||
        listing.status === LookupStatus.EXPIRED ||
        (recoverEvicted && rowEvicted(key, result, listing, parent)))
    ) {
      refilled = await refillSnapshot(accessor, index, prefix)
      result = await index.get(key)
      listing = await index.listDir(key)
      parent = key === root ? listing : await index.listDir(parentKey)
    }
    // A lock wait can outlast the TTL; use this refill only on EXPIRED.
    if (
      refilled !== null &&
      (listing.status === LookupStatus.EXPIRED || parent.status === LookupStatus.EXPIRED)
    ) {
      refilled = index.scopeSnapshot(refilled)
      const children = refilled.children.get(key)
      return {
        entry: refilled.entries.get(key) ?? null,
        children: children === undefined ? null : [...children],
      }
    }
    return { entry: result.entry ?? null, children: listing.entries ?? null }
  })
}

/** Whether the parent lists `key` while neither its row nor its listing is stored. */
function rowEvicted(
  key: string,
  result: LookupResult,
  listing: ListResult,
  parent: ListResult,
): boolean {
  return (
    result.entry == null &&
    listing.entries == null &&
    parent !== listing &&
    parent.entries?.includes(key) === true
  )
}

/**
 * `lookup`, asked once more if the index was cleared under it.
 *
 * A reconcile verdict clears the mount index, and one landing between the
 * refill and the read leaves a miss that only says the store is empty. Read as
 * absence, that miss reaches `onOpMissing` through a dispatcher door and drops
 * the path's overlay for good. Two signs tell that miss from a real one: the
 * root listing is gone (a live index always has one), or the accessor refilled
 * an index while the lookup ran, which is a clear followed by a concurrent
 * reseed. The first lookup's own eviction refill counts as one, so the second
 * lookup does not refill for a listed name with no row: a row that refill did
 * not bring back is absent after one refill, not two.
 */
export async function lookupRetrying(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
): Promise<Found> {
  const refills = accessor.refills
  const found = await lookup(accessor, index, prefix, key)
  if (exists(found) || index === undefined) return found
  const root = await index.listDir(keyOf(prefix, ''))
  if (root.status !== LookupStatus.NOT_FOUND && accessor.refills === refills) return found
  return lookup(accessor, index, prefix, key, false)
}

/**
 * Answer one path with one request, where a whole walk would be waste.
 *
 * Taken only when the index holds no tree at all while the mount has loaded
 * one before: the throwaway store reconcile and the drift check stat through,
 * or a mount index a verdict just cleared. A mount that never loaded its tree
 * seeds it as it always has, and a live or expired index keeps its own answer.
 * Nothing is written back: one row is not a listing, and seeding it would make
 * every other path read as absent.
 *
 * The row's id is the git oid a tree row carries. Its mtime can differ from
 * the tree's: paths-info expands commits only when the mount forces it, while
 * the tree's own default expands a repository small enough.
 */
export async function pointLookup(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  rel: string,
): Promise<Found | null> {
  if (index === undefined || !accessor.treeLoaded) return null
  const root = await index.listDir(keyOf(prefix, ''))
  if (root.status !== LookupStatus.NOT_FOUND) return null
  const { entries } = indexRows(await fetchPath(accessor, rel), prefix)
  return { entry: entries.get(keyOf(prefix, rel)) ?? null, children: null }
}

/**
 * Report a repository the Hub will not show as permission denied.
 *
 * A 401, 403 or 404 for the repository or revision is the Hub declining to
 * show the listing, so the path answers the way a directory the caller may not
 * open does: every file tool already reports that and steps past it, where a
 * raw Hub error would stop a walk across other mounts. It is never absence,
 * which reconcile would turn into a delete.
 */
export async function refusalsDenied<T>(
  pathSpec: PathSpec,
  run: () => Promise<T>,
  statuses: ReadonlySet<number> = ABSENT_STATUSES,
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw asRefusal(pathSpec, err, statuses)
  }
}

/** The error to rethrow for `err`: EACCES for a refusal, `err` itself otherwise. */
export function asRefusal(
  pathSpec: PathSpec,
  err: unknown,
  statuses: ReadonlySet<number> = ABSENT_STATUSES,
): unknown {
  return err instanceof HfHubError && statuses.has(err.status) ? eacces(pathSpec) : err
}

/** The mount-absolute key for a mount-local path. */
export function keyOf(prefix: string, local: string): string {
  const rel = stripSlash(local)
  const stem = rstripSlash(prefix)
  if (rel === '') return stem === '' ? '/' : stem
  return stem === '' ? `/${rel}` : `${stem}/${rel}`
}

/** Whether a mount-local path exists as a non-directory. */
export async function probeFile(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  local: string,
): Promise<boolean> {
  const found = await lookup(accessor, index, prefix, keyOf(prefix, local))
  return exists(found) && !isDir(found)
}

/** Whether a mount-local path exists as a directory. */
export async function probeDir(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  local: string,
): Promise<boolean> {
  return isDir(await lookup(accessor, index, prefix, keyOf(prefix, local)))
}

/** A row for a directory the tree implies but has no row for. */
export function dirStatEntry(key: string): IndexEntry {
  const trimmed = rstripSlash(key)
  const cut = trimmed.lastIndexOf('/')
  return new IndexEntry({
    id: '',
    name: (cut === -1 ? trimmed : trimmed.slice(cut + 1)) || '/',
    resourceType: 'folder',
  })
}
