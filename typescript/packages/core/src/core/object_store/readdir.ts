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

import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { TreeEntry } from './driver.ts'
import type { Accessor } from '../../accessor/base.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import { listingError } from '../../errors/fs.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { ObjectStoreDriver, ReaddirFn, TreeFn } from './driver.ts'

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
  await index.invalidateEntry(virtual)
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

/**
 * Reuse a complete tree, or cache a successful backend listing. The rows are
 * the key at the path itself and every key under it, as `listSubtree` gives
 * them, markers included. Mirrors Python's `read_tree`.
 */
export async function readTree<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<TreeEntry[]> {
  const kpfx = driver.keyPrefixOf(accessor)
  const stem = rstripSlash(kp.apply(kpfx, path.mountPath))
  const prefix = stem === '' ? '' : stem + '/'
  const virtual = rstripSlash(path.virtual) || '/'
  const root = await cachedEntry(index, virtual)
  const knownDirectory =
    path.mountPath.replaceAll('/', '') === '' || root?.resourceType === ResourceType.FOLDER
  const cached =
    root?.extra.object_store_collision !== true && knownDirectory
      ? await cachedTree(index, virtual, prefix)
      : null
  if (cached !== null) return cached
  if (index !== undefined) {
    const parent = await index.listDir(virtual.slice(0, virtual.lastIndexOf('/')) || '/')
    if (
      parent.entries?.includes(virtual) === true &&
      root?.resourceType === ResourceType.FILE &&
      root.size != null
    ) {
      return [{ key: stem, size: root.size }]
    }
  }
  const { conn, close } = await driver.connect(accessor)
  const entries: TreeEntry[] = []
  try {
    for await (const entry of driver.listSubtree(conn, stem)) entries.push(entry)
  } finally {
    await close()
  }
  if (
    !entries.some((e) => e.key === stem) &&
    (entries.some((e) => e.key.startsWith(prefix)) || path.mountPath.replaceAll('/', '') === '')
  ) {
    await cacheTree(index, virtual, prefix, entries)
    await index?.put(
      virtual,
      new IndexEntry({
        id: virtual,
        name: virtual.slice(virtual.lastIndexOf('/') + 1) || '/',
        resourceType: ResourceType.FOLDER,
      }),
    )
  }
  return entries
}

/**
 * Build `readTree` over one driver: one recursive listing. A file stats as a
 * listing leaves it in the index (its size, time and content type); a
 * directory, a marker or a key prefix alike, carries nothing but its name. A
 * marker for `path` itself names no entry. Null, so the walk's readdir and
 * stat answer instead, when nothing is under the prefix, when a row has no
 * size, when a key has an empty segment, and when one name is both a file and
 * a prefix, which a readdir lists as a directory. Mirrors Python's
 * `make_tree`.
 */
export function makeTree<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): TreeFn<A> {
  return async (accessor, path, index) => {
    const rows = await readTree(driver, accessor, path, index)
    const prefix = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    if (!rows.some((row) => row.key.startsWith(prefix))) return null
    const found = new Map<string, FileStat>()
    const dirs = new Set<string>()
    for (const row of rows) {
      if (!row.key.startsWith(prefix)) continue
      const raw = row.key.slice(prefix.length)
      const isDir = raw.endsWith('/')
      const rel = rstripSlash(raw)
      if (rel === '') continue
      const parts = rel.split('/')
      if (parts.includes('') || (!isDir && (row.size ?? null) === null)) return null
      for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
      if (isDir) {
        dirs.add(rel)
        continue
      }
      const name = parts[parts.length - 1] ?? rel
      found.set(
        rel,
        new FileStat({
          name,
          size: row.size ?? null,
          modified: row.modified !== undefined && row.modified !== '' ? row.modified : null,
          type: FileType.FILE,
          content: contentTypeForPath(name),
        }),
      )
    }
    for (const rel of dirs) {
      if (found.has(rel)) return null
      found.set(
        rel,
        new FileStat({ name: rel.slice(rel.lastIndexOf('/') + 1), type: FileType.DIRECTORY }),
      )
    }
    return found
  }
}
