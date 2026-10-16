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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { enoent } from '../../errors/fs.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

/**
 * The key a mount keeps `path` under in its index: the virtual path, the
 * mount root spelled without its slash. A glob word is keyed as the
 * directory it lists. Mirrors Python's `index_key`.
 */
export function indexKey(prefix: string, path: PathSpec): string {
  const root = rstripSlash(prefix)
  const key = stripSlash((path.pattern !== null ? path.dir : path).vfsPath)
  return key !== '' ? `${root}/${key}` : root || '/'
}

/** The key of the directory holding `key`; the root holds itself. */
export function folderOf(key: string): string {
  return key.slice(0, key.lastIndexOf('/')) || '/'
}

/**
 * A directory's listing as the index holds it, null when the index holds no
 * complete, live listing for it. The mount's read policy rides the index: a
 * listing past its bound, or one a `fresh` mount's check refuses, answers
 * null here. A window (the newest messages, the last days) answers no glob:
 * the backend moves its window to the span the glob asks for. Mirrors
 * Python's `stored_listing`.
 */
export async function storedListing(
  index: IndexCacheStore,
  key: string,
  glob = false,
): Promise<string[] | null> {
  const listing = await index.listDir(key)
  if (glob && listing.window === true) return null
  return listing.entries ?? null
}

/**
 * Whether `key`'s folder holds a window that does not name it. A window shows
 * everything to show but proves nothing absent: a day it does not list may
 * still be there, and only the backend says. Mirrors Python's
 * `beyond_window`.
 */
export async function beyondWindow(index: IndexCacheStore, key: string): Promise<boolean> {
  const listing = await index.listDir(folderOf(key))
  return listing.window === true && listing.entries != null && !listing.entries.includes(key)
}

/**
 * Keep what a backend listed, and answer the children's paths. A plain list is
 * the directory's whole listing. A `DirListing` may also prove descendant
 * listings (`seeds`), be a view rather than the whole directory (`partial`),
 * or prove nothing absent (`window`); each is kept for what it proves, and a
 * seed at the version its listing was read at.
 */
export async function keepListing(
  index: IndexCacheStore,
  key: string,
  listed: readonly FileStat[] | DirListing,
): Promise<string[]> {
  const listing = listed instanceof DirListing ? listed : new DirListing({ entries: listed })
  const rows: [string, FileStat][] = listing.entries.map((row) => [row.name, row])
  if (listing.partial) await index.setPartialDir(key, rows)
  else await index.setDir(key, rows, null, { window: listing.window, version: listing.version })
  const stem = key === '/' ? '' : key
  for (const [relative, children] of listing.seeds) {
    const seeded: [string, FileStat][] = children.map((row) => [row.name, row])
    await index.setDir(`${stem}/${stripSlash(relative)}`, seeded, null, {
      window: listing.window,
      version: listing.version,
    })
  }
  return listing.entries.map((row) => `${stem}/${row.name}`)
}

/**
 * Whether the stored listing of the path's folder leaves it out without
 * proving it absent: a complete listing the running command did not fetch,
 * which another client may have added the name to since. Mirrors Python's
 * `unproven_miss`.
 */
export async function unprovenMiss(index: IndexCacheStore, key: string): Promise<boolean> {
  const folder = folderOf(key)
  const listing = await index.listDir(folder)
  return (
    listing.entries != null &&
    listing.window !== true &&
    !listing.entries.includes(key) &&
    !index.listedThisCommand(folder)
  )
}

/**
 * A stat the stored listings answer, null when none does. The row the
 * parent's listing holds answers it, so a listing costs one request and the
 * stat of each child after it none. A complete listing that does not name the
 * path rejects with ENOENT the same way; a window that does not answers
 * nothing. A directory whose own listing is held
 * answers with the row a subtree read kept for it. `key` is below the mount
 * root.
 */
export async function storedStat(index: IndexCacheStore, key: string): Promise<FileStat | null> {
  const listing = await index.listDir(folderOf(key))
  if (listing.entries != null) {
    if (!listing.entries.includes(key)) {
      if (listing.window === true) return null
      throw enoent(key)
    }
  } else if (listing.partialEntries?.includes(key) !== true) {
    if ((await storedListing(index, key)) === null) return null
  }
  const row = (await index.get(key)).entry
  return row instanceof FileStat ? row : null
}

/**
 * What is at `key`, as its parent's listing names it, listing the parent
 * through `warm` when no listing proves it; null when nothing is there. `key`
 * is below the mount root, which no listing names.
 */
export async function entryAt(
  index: IndexCacheStore,
  key: string,
  warm: (() => Promise<string[]>) | null,
): Promise<FileStat | null> {
  const row = await entryOrWarm(index, key, warm)
  return row instanceof FileStat ? row : null
}

/**
 * A subtree read the stored listings answer, null when one does not: every
 * entry below the directory as its parent's listing holds it, keyed by its
 * path below `key`, which is what a walk of `readdir` and `stat` over the same
 * listings would see. Null while any directory under it has no complete, live
 * listing; a window is not one. Mirrors Python's `stored_tree`.
 */
export async function storedTree(
  index: IndexCacheStore,
  key: string,
): Promise<Map<string, FileStat> | null> {
  const found = new Map<string, FileStat>()
  const base = key === '/' ? '' : key
  const pending = [key]
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    const listing = await index.listDir(folder)
    const children = listing.window === true ? null : (listing.entries ?? null)
    if (children === null) return null
    for (const child of children) {
      const row: unknown = (await index.get(child)).entry
      if (!(row instanceof FileStat)) return null
      found.set(child.slice(base.length + 1), row)
      if (row.type === FileType.DIRECTORY) pending.push(child)
    }
  }
  return found
}

/**
 * Keep a subtree read as the listings it proves: it names everything below the
 * directory, so it is a complete listing of the directory and of each
 * directory below it. The directory's own stat, which a read may name under
 * `''`, is kept where a stat of it finds it. A folder whose listing is live
 * keeps it: one that landed while the read ran may be newer than the read, and
 * replacing it would report its newer children gone. Mirrors Python's
 * `keep_tree`.
 */
export async function keepTree(
  index: IndexCacheStore,
  key: string,
  tree: ReadonlyMap<string, FileStat>,
): Promise<void> {
  const base = key === '/' ? '' : key
  const listings = new Map<string, [string, FileStat][]>([[key, []]])
  for (const relative of [...tree.keys()].sort(compareCodePoints)) {
    const row = tree.get(relative)
    if (row === undefined) continue
    if (relative === '') {
      await index.put(key, row)
      continue
    }
    const cut = relative.lastIndexOf('/')
    const folder = cut === -1 ? key : `${base}/${relative.slice(0, cut)}`
    const rows = listings.get(folder) ?? []
    rows.push([row.name, row])
    listings.set(folder, rows)
    if (row.type === FileType.DIRECTORY && !listings.has(`${base}/${relative}`)) {
      listings.set(`${base}/${relative}`, [])
    }
  }
  for (const [folder, rows] of listings) {
    if ((await index.listDir(folder)).entries == null) await index.setDir(folder, rows)
  }
}
