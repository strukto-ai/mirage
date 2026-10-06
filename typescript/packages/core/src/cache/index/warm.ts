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

import { isEnoent } from '../../errors/fs.ts'
import { type IndexEntry, LookupStatus } from './config.ts'
import type { IndexCacheStore } from './store.ts'
import { withIndexLock } from './lock.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * Resolve an index entry, listing the parent directory once when its listing
 * is missing or expired.
 *
 * Id-addressed backends (Drive, Box, Dropbox, Gmail) can only turn a path into
 * an id through the index, so a cold lookup has to warm it from the parent's
 * listing and retry. Every such backend had grown its own copy of that block;
 * this is the one place that decides what a failed listing means.
 *
 * A missing parent listing does not prove a retained entry is current: a
 * partial warm may have stored the child without publishing freshness. Such
 * a child is dropped before the refresh. A fresh partial listing proves only
 * the children it names; an omitted child still refreshes.
 * A parent that is simply absent is not an error here — the caller reports
 * ENOENT against the operand, which is the
 * path GNU names (`rm nodir/f` says "cannot remove 'nodir/f'", not "nodir").
 * Every other failure propagates: an expired token or a dropped connection
 * reported as "no such file" both misdiagnoses the fault and hides that it is
 * worth retrying.
 *
 * Mirrors Python's entry_or_warm.
 *
 * @param index - the index to read, and to warm through `warm`.
 * @param virtualKey - the index key being resolved.
 * @param warm - lists the parent directory, populating the index; null when
 *   the key has no distinct parent to list.
 */
export async function entryOrWarm(
  index: IndexCacheStore,
  virtualKey: string,
  warm: (() => Promise<unknown>) | null,
): Promise<IndexEntry | null> {
  const parent = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  return withIndexLock(index, parent, async () => {
    let listing = await index.listDir(parent)
    if (listing.entries != null && !listing.entries.includes(virtualKey)) return null
    const hit = await index.get(virtualKey)
    if (
      hit.entry != null &&
      (listing.entries != null || listing.partialEntries?.includes(virtualKey) === true)
    )
      return hit.entry
    if (warm === null) return null
    if (listing.status === LookupStatus.EXPIRED) {
      // Retained metadata is not proof of existence. Drop the old children
      // before warming, including when a best-effort listing only puts rows.
      await index.invalidateDir(parent)
    }
    if (hit.entry != null) {
      // Put-only rows have no parent membership to remove. A missing or
      // partial refresh must not leave the old target available to the retry.
      await index.invalidatePrefix(virtualKey)
    }
    try {
      await warm()
    } catch (err) {
      if (!isEnoent(err)) throw err
      return null
    }
    listing = await index.listDir(parent)
    if (listing.entries != null && !listing.entries.includes(virtualKey)) return null
    const warmed = await index.get(virtualKey)
    return warmed.entry ?? null
  })
}
