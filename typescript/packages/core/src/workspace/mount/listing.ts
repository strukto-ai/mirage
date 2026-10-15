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

import type { IndexRow } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { enoent } from '../../errors/fs.ts'
import { DirListing, FileStat, type PathSpec } from '../../types.ts'

/**
 * The key a mount keeps `path` under in its index: the virtual path, the
 * mount root spelled without its slash. A glob word is keyed as the
 * directory it lists. Mirrors Python's `index_key`.
 */
export function indexKey(prefix: string, path: PathSpec): string {
  const root = prefix.replace(/\/+$/, '')
  const key = (path.pattern !== null ? path.dir : path).vfsPath.replace(/^\/+|\/+$/g, '')
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
 * null here.
 */
export async function storedListing(index: IndexCacheStore, key: string): Promise<string[] | null> {
  return (await index.listDir(key)).entries ?? null
}

/**
 * Keep what a backend listed, and answer the children's paths. A plain list is
 * the directory's whole listing. A `DirListing` may also prove descendant
 * listings (`seeds`), be a view rather than the whole directory (`partial`),
 * or prove nothing absent (`window`); each is kept for what it proves.
 */
export async function keepListing(
  index: IndexCacheStore,
  key: string,
  listed: readonly FileStat[] | DirListing,
): Promise<string[]> {
  const listing = listed instanceof DirListing ? listed : new DirListing({ entries: listed })
  const rows: [string, IndexRow][] = listing.entries.map((row) => [row.name, row])
  if (listing.partial) await index.setPartialDir(key, rows)
  else await index.setDir(key, rows, null, { window: listing.window })
  const stem = key === '/' ? '' : key
  for (const [relative, children] of listing.seeds) {
    const seeded: [string, IndexRow][] = children.map((row) => [row.name, row])
    await index.setDir(`${stem}/${relative.replace(/^\/+|\/+$/g, '')}`, seeded, null, {
      window: listing.window,
    })
  }
  return listing.entries.map((row) => `${stem}/${row.name}`)
}

/**
 * A stat the stored listings answer, null when none does. The row the
 * parent's listing holds answers it, so a listing costs one request and the
 * stat of each child after it none. A complete listing that does not name the
 * path rejects with ENOENT the same way. `key` is below the mount root.
 */
export async function storedStat(index: IndexCacheStore, key: string): Promise<FileStat | null> {
  const listing = await index.listDir(folderOf(key))
  if (listing.entries != null) {
    if (!listing.entries.includes(key)) throw enoent(key)
  } else if (listing.partialEntries?.includes(key) !== true) {
    return null
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
