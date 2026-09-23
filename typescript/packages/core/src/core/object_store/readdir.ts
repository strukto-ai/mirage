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

import type { PathSpec } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindHints, TreeEntry } from './driver.ts'
import type { Accessor } from '../../accessor/base.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import { listingError } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { ObjectStoreDriver, ReaddirFn } from './driver.ts'

async function probeFile<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return (await driver.head(conn, kp.apply(kpfx, key))) !== null
}

async function probeDir<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return driver.probePrefix(conn, kp.applyDir(kpfx, key))
}

/** Build a prefix listing with index write-back over one driver. */
export function makeReaddir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): ReaddirFn<A> {
  return async function readdir(accessor, path, index) {
    const prefix = mountPrefixOf(path.virtual, path.vfsPath)
    // When called from resolveGlob with a pattern (e.g. *.txt), use
    // path.directory for the listing. Direct callers (ls, ops) pass
    // pattern=null so path.virtual is used.
    const virtual = path.pattern !== null ? path.directory : path.virtual
    const rawPath =
      prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual
    const virtualKey = rawPath === '/' ? '/' : rstripSlash(rawPath) || '/'
    const rawFullKey = prefix !== '' ? `${prefix}${virtualKey}` : virtualKey
    const fullVirtualKey = rstripSlash(rawFullKey) || '/'
    if (index !== undefined) {
      const listing = await index.listDir(fullVirtualKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries
      }
      await cachedEntry(index, fullVirtualKey)
    }
    const kpfx = driver.keyPrefixOf(accessor)
    const pfx = kp.applyDir(kpfx, rawPath)
    const names: string[] = []
    const dirKeys = new Set<string>()
    const sizes = new Map<string, number | null>()
    const times = new Map<string, string>()
    let sawKey = false
    const { conn, close } = await driver.connect(accessor)
    try {
      for await (const child of driver.listChildren(conn, pfx)) {
        sawKey = true
        if (child.kind === 'marker') continue
        const key = '/' + kp.strip(kpfx, child.key)
        if (child.kind === 'd') {
          if (dirKeys.has(key)) continue
          names.push(key)
          dirKeys.add(key)
        } else {
          names.push(key)
          sizes.set(key, child.size ?? null)
          times.set(key, child.modified ?? '')
        }
      }
      if (!sawKey && rstripSlash(rawPath) !== '') {
        // An empty directory is a zero-byte marker object keyed at the
        // prefix itself, so a prefix holding no key at all -- not even that
        // marker -- is a path the store does not have. Without this, `ls`
        // on a missing path rendered an empty directory and exited 0 where
        // every real filesystem reports ENOENT. The mount root is exempt:
        // it exists because it is mounted.
        throw await listingError(
          path,
          rawPath,
          (p) => probeFile(driver, conn, kpfx, p),
          (p) => probeDir(driver, conn, kpfx, p),
        )
      }
    } finally {
      await close()
    }
    names.sort(compareCodePoints)
    if (names.length > driver.scopeError) {
      console.warn(
        `${driver.vfs} readdir: ${fullVirtualKey} returned ` +
          `${String(names.length)} entries (limit ${String(driver.scopeError)})`,
      )
    }
    const virtualEntries = names
      .map((e) => (prefix !== '' ? `${prefix}${e}` : e))
      .sort(compareCodePoints)
    if (index !== undefined) {
      const indexEntries: [string, IndexEntry][] = names.map((e) => {
        const name = e.split('/').pop() ?? ''
        if (dirKeys.has(e)) {
          // Store "folders" are synthetic prefixes with no object of their
          // own, so there is no mtime or size to record.
          return [
            name,
            new IndexEntry({
              id: e,
              name,
              resourceType: ResourceType.FOLDER,
              extra: sizes.has(e) ? { object_store_collision: true } : {},
            }),
          ]
        }
        return [
          name,
          new IndexEntry({
            id: e,
            name,
            resourceType: ResourceType.FILE,
            size: sizes.get(e) ?? null,
            remoteTime: times.get(e) ?? '',
          }),
        ]
      })
      await index.setDir(fullVirtualKey, indexEntries)
    }
    return virtualEntries
  }
}

/** Trust metadata only while a listing still proves the path exists. */
export async function cachedEntry(
  index: IndexCacheStore | undefined,
  virtual: string,
): Promise<IndexEntry | null> {
  const entry = (await index?.get(virtual))?.entry
  if (entry == null || index === undefined) return null
  const parent = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  const siblings = (await index.listDir(parent)).entries
  if (siblings?.includes(virtual) === true) return entry
  if (entry.resourceType === ResourceType.FOLDER && (await index.listDir(virtual)).entries != null)
    return entry
  // A later listing must not revive metadata from an expired generation.
  await index.invalidatePrefix(virtual)
  return null
}

/** Read a subtree only while every directory listing is complete and fresh. */
async function cachedTree(
  index: IndexCacheStore | undefined,
  virtual: string,
  key: string,
): Promise<TreeEntry[] | null> {
  if (index === undefined) return null
  const found: TreeEntry[] = []
  const pending: [string, string][] = [[virtual, key]]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    const [directory, prefix] = next
    const listing = await index.listDir(directory)
    if (listing.entries == null) return null
    for (const child of listing.entries) {
      const { entry } = await index.get(child)
      if (entry == null || entry.extra.object_store_collision) return null
      const childKey = prefix + child.slice(child.lastIndexOf('/') + 1)
      if (entry.resourceType === ResourceType.FOLDER) {
        found.push({ key: childKey + '/' })
        pending.push([child, childKey + '/'])
      } else if (entry.size == null) return null
      else found.push({ key: childKey, size: entry.size, modified: entry.remoteTime })
    }
  }
  return found.length > 0 ? found : [{ key }]
}

/** Publish complete listings only after the recursive backend walk succeeds. */
async function cacheTree(
  index: IndexCacheStore | undefined,
  virtual: string,
  key: string,
  entries: TreeEntry[],
): Promise<void> {
  if (index === undefined) return
  if (entries.some((row) => row.size === undefined && !row.key.endsWith('/'))) return
  const directories = new Map<string, Map<string, IndexEntry>>([[virtual, new Map()]])
  const files = new Set<string>()
  for (const row of entries) {
    if (!row.key.startsWith(key) || row.key === key) continue
    const relative = rstripSlash(row.key.slice(key.length))
    if (relative === '') continue
    const parts = relative.split('/')
    let parent = virtual
    for (const [i, name] of parts.entries()) {
      const child = rstripSlash(parent) + '/' + name
      const isDir = i < parts.length - 1 || row.key.endsWith('/')
      if (isDir) {
        if (!directories.has(child)) directories.set(child, new Map())
      } else files.add(child)
      const children = directories.get(parent)
      if (children === undefined) throw new Error('Missing parent in object-store listing')
      children.set(
        name,
        new IndexEntry({
          id: child,
          name,
          resourceType: isDir ? ResourceType.FOLDER : ResourceType.FILE,
          size: isDir ? null : (row.size ?? 0),
          remoteTime: isDir ? '' : (row.modified ?? ''),
        }),
      )
      parent = child
    }
  }
  if ([...files].some((file) => directories.has(file))) return
  for (const [directory, children] of directories) {
    await index.setDir(directory, [...children])
  }
}

/** Reuse complete metadata trees; narrowed searches never publish listings. */
export async function readTree<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
  hints?: FindHints,
): Promise<[TreeEntry[], boolean]> {
  const kpfx = driver.keyPrefixOf(accessor)
  const stem = rstripSlash(kp.apply(kpfx, path.mountPath))
  const prefix = stem === '' ? '' : stem + '/'
  const virtual = rstripSlash(path.virtual) || '/'
  const root = await cachedEntry(index, virtual)
  const knownDirectory =
    path.mountPath.replaceAll('/', '') === '' || root?.resourceType === ResourceType.FOLDER
  const cached =
    !root?.extra.object_store_collision && (hints !== undefined || knownDirectory)
      ? await cachedTree(index, virtual, prefix)
      : null
  if (cached !== null) return [cached, false]
  if (hints === undefined && index !== undefined) {
    const entry = root
    const parent = await index.listDir(virtual.slice(0, virtual.lastIndexOf('/')) || '/')
    if (
      parent.entries?.includes(virtual) === true &&
      entry?.resourceType === ResourceType.FILE &&
      entry.size != null
    ) {
      return [[{ key: stem, size: entry.size }], false]
    }
  }
  const { conn, close } = await driver.connect(accessor)
  let narrowed = false
  const entries: TreeEntry[] = []
  let exists = false
  try {
    let iterator: AsyncIterable<TreeEntry>
    if (hints === undefined) iterator = driver.listSubtree(conn, stem)
    else if (driver.findTree !== undefined)
      [iterator, narrowed] = driver.findTree(conn, prefix, hints)
    else iterator = driver.listTree(conn, prefix)
    for await (const entry of iterator) entries.push(entry)
    exists = narrowed && entries.length === 0 && (await driver.probePrefix(conn, prefix))
    if (
      !narrowed &&
      !entries.some((e) => e.key === stem) &&
      (entries.some((e) => e.key.startsWith(prefix)) || path.mountPath.replaceAll('/', '') === '')
    ) {
      await cacheTree(index, virtual, prefix, entries)
      // A find prefix omits a coexisting file root. Verify that slot
      // before publishing a folder that later commands trust.
      if (
        hints === undefined ||
        (knownDirectory && !root?.extra.object_store_collision) ||
        (index !== undefined && (await driver.head(conn, stem)) === null)
      )
        await index?.put(
          virtual,
          new IndexEntry({
            id: virtual,
            name: virtual.slice(virtual.lastIndexOf('/') + 1) || '/',
            resourceType: ResourceType.FOLDER,
          }),
        )
    }
  } finally {
    await close()
  }
  return [entries, exists]
}
