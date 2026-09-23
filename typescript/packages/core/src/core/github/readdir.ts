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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubAccessor } from '../../accessor/github.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { fetchDirTree, type GitHubTreeItem } from './client.ts'
import { ensureLiveIndex, refillIndex } from './tree.ts'
import { withIndexLock } from '../../cache/index/lock.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'
import { compareCodePoints } from '../../utils/sort.ts'

function stripPrefix(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

export async function readdir(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  if (index === undefined) return readdirUnlocked(accessor, path, index)
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  return withIndexLock(index, rstripSlash(prefix) || '/', () =>
    readdirUnlocked(accessor, path, index),
  )
}

/** Caller holds the mount's index lock through its final lookup. */
export async function readdirUnlocked(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  if (index === undefined) {
    throw enoent(path.virtual)
  }
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const rel = stripSlash(stripPrefix(path))
  const key =
    rel === '' ? (prefix === '' ? '/' : rstripSlash(prefix)) : `${rstripSlash(prefix)}/${rel}`

  await ensureLiveIndex(accessor, index, prefix)
  let listing = await index.listDir(key)
  // The index is the whole listing here, not a cache in front of one, so an
  // *expired* answer means the tree aged out, not that the path is gone.
  // Refetch once and ask again. A NOT_FOUND against a live index is a real
  // absence and must not cost a tree fetch: refilling on any miss spends a
  // recursive-tree call on every ENOENT.
  if (listing.status === LookupStatus.EXPIRED && !accessor.truncated) {
    if (await refillIndex(accessor, index, prefix)) listing = await index.listDir(key)
  }
  if (listing.entries !== undefined && listing.entries !== null) {
    return listing.entries
  }
  if (
    accessor.truncated &&
    (listing.status === LookupStatus.NOT_FOUND || listing.status === LookupStatus.EXPIRED)
  ) {
    return fallbackReaddir(accessor, key, index, prefix)
  }
  if (listing.status === LookupStatus.NOT_FOUND) throw enoent(path)
  return []
}

async function fallbackReaddir(
  accessor: GitHubAccessor,
  key: string,
  index: IndexCacheStore,
  prefix: string,
): Promise<string[]> {
  const parentSha = await resolveDirSha(accessor, key, index, prefix)
  if (parentSha === null) throw enoent(key)
  const entries = await fetchDirTree(accessor.transport, accessor.owner, accessor.repo, parentSha)
  return cacheDir(index, key, entries)
}

// Cache one complete tree listing, including each traversed parent.
async function cacheDir(
  index: IndexCacheStore,
  key: string,
  entries: GitHubTreeItem[],
): Promise<string[]> {
  const childKeys: string[] = []
  const childEntries: [string, IndexEntry][] = []
  for (const e of entries) {
    const childKey = `${key === '/' ? '' : key}/${e.path}`
    childKeys.push(childKey)
    // setDir composes the child key as parent + '/' + name, so the tuple
    // carries the bare entry name, not the full path (mirrors python).
    childEntries.push([
      e.path,
      new IndexEntry({
        id: e.sha,
        name: e.path,
        vfsName: e.path,
        resourceType: e.type === 'tree' ? 'folder' : 'file',
        size: e.size ?? null,
      }),
    ])
  }
  childKeys.sort(compareCodePoints)
  await index.setDir(key, childEntries)
  return childKeys
}

async function resolveDirSha(
  accessor: GitHubAccessor,
  key: string,
  index: IndexCacheStore,
  prefix: string,
): Promise<string | null> {
  // Cached directory SHAs may belong to an older branch head, even when
  // their parent listing is still fresh. Resolve the path from the ref.
  const stem = rstripSlash(prefix)
  const rest = stem !== '' && key.startsWith(stem) ? key.slice(stem.length) : key
  const parts = stripSlash(rest)
    .split('/')
    .filter((p) => p !== '')
  let currentSha = accessor.ref
  let currentPath = stem || '/'
  for (const part of parts) {
    const entries = await fetchDirTree(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      currentSha,
    )
    const childPath = `${currentPath === '/' ? '' : currentPath}/${part}`
    const found = entries.find((e) => e.path === part)
    if (found?.type !== 'tree') {
      // Remove the former directory before caching a replacement blob.
      await index.invalidatePrefix(childPath)
    }
    await cacheDir(index, currentPath, entries)
    if (found?.type !== 'tree') return null
    currentSha = found.sha
    currentPath = childPath
  }
  return currentSha
}
