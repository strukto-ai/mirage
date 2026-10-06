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

import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { GoogleApiError, type TokenManager } from './client.ts'
import { getFile } from './drive.ts'

/** Resolve a native app file without an account-wide search. */
export async function resolveAppEntry(
  tokenManager: TokenManager,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  mime: string,
  resourceType: string,
  filename: (title: string, id: string, modified: string) => string,
): Promise<IndexEntry> {
  const parent = path.virtual.slice(0, path.virtual.lastIndexOf('/'))
  const listing = await index?.listDir(parent)
  if (listing?.entries != null && !listing.entries.includes(path.virtual)) {
    throw enoent(path.virtual)
  }
  const hit = await index?.get(path.virtual)
  if (hit?.entry && (listing?.entries ?? listing?.partialEntries ?? []).includes(path.virtual)) {
    return hit.entry
  }
  const fileId = match.slots.file_id
  if (fileId === undefined) throw enoent(path.virtual)
  let item
  try {
    item = await getFile(tokenManager, fileId)
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.status !== 404) throw err
    await index?.invalidatePrefix(path.virtual)
    throw enoent(path.virtual)
  }
  const modified = item.modifiedTime ?? ''
  const name = filename(item.name, item.id, modified)
  const owned = item.owners?.[0]?.me === true
  if (
    item.trashed === true ||
    item.mimeType !== mime ||
    owned !== (match.slots.corpus === 'owned') ||
    name !== path.vfsPath.split('/').at(-1)
  ) {
    await index?.invalidatePrefix(path.virtual)
    throw enoent(path.virtual)
  }
  const sourceSize = Number.parseInt(item.size ?? item.quotaBytesUsed ?? '0', 10)
  const entry = new IndexEntry({
    id: item.id,
    name: item.name,
    resourceType,
    remoteTime: modified,
    vfsName: name,
    extra: Number.isFinite(sourceSize) && sourceSize > 0 ? { source_size: sourceSize } : {},
  })
  await index?.put(path.virtual, entry)
  return entry
}
