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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType } from '../../types.ts'
import { scalarString } from '../slug_tree/rows.ts'
import { pagesChunks } from './client.ts'
import { renderPage } from './render.ts'

/**
 * Fill in the exact size of every unsized file in one directory.
 *
 * The path tree's own `size` is producer-supplied and describes the source
 * document, not the chunk join mirage serves, so it cannot be trusted as a
 * byte length. This pays one scan per directory actually stat'd instead, and
 * only for files still missing a size. A page with no chunks reads as nothing,
 * so it is sized 0 and never scanned again.
 */
export async function ensureDirSizes(
  accessor: ChromaAccessor,
  directory: string,
  index: IndexCacheStore,
): Promise<void> {
  const listing = await index.listDir(directory)
  if (listing.entries === undefined || listing.entries === null) return
  const pending = new Map<string, FileStat>()
  for (const child of listing.entries) {
    const entry: unknown = (await index.get(child)).entry
    if (entry instanceof FileStat && entry.type === FileType.FILE && entry.size === null) {
      pending.set(child, entry)
    }
  }
  if (pending.size === 0) return
  const slugs: string[] = []
  for (const entry of pending.values()) {
    const slug = scalarString(entry.extra.slug)
    if (slug !== null) slugs.push(slug)
  }
  const grouped = await pagesChunks(accessor, slugs)
  for (const [child, entry] of pending) {
    const chunks = grouped.get(scalarString(entry.extra.slug) ?? '') ?? []
    await index.put(child, entry.with({ size: renderPage(chunks).byteLength }))
  }
}
