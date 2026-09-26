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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record, startOp } from '../../observe/context.ts'
import { type PathSpec, VFSName } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { fetchBlob } from './client.ts'
import { lookupRetrying } from './lookup.ts'

/**
 * Read a file's blob and record the sha it was fetched by.
 *
 * The sha comes from the mount's listing, filling it if a verdict cleared
 * it, never from a one-directory probe: a read reseeds the listing so the
 * stats after it answer from the index again. The blob endpoint is
 * content-addressed, so the recorded sha names exactly the bytes returned
 * however old the listing is. That is also the documented limit of
 * `read: fresh` here: a file read for the first time comes from the
 * listing, and the next read's probe corrects it.
 *
 * Mirrors Python's `read`.
 */
export async function read(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let rel = path.virtual
  if (prefix !== '' && rel.startsWith(prefix)) rel = rel.slice(prefix.length) || '/'
  const trimmed = stripSlash(rel)
  if (trimmed === '') throw eisdir(path.virtual)
  if (index === undefined) throw enoent(path)
  const key = `${rstripSlash(prefix)}/${trimmed}`
  const { entry } = await lookupRetrying(accessor, index, prefix, key)
  if (entry === null) throw enoent(path)
  if (entry.resourceType === 'folder') throw eisdir(path.virtual)
  const timer = startOp()
  const data = await fetchBlob(accessor.transport, accessor.owner, accessor.repo, entry.id)
  record('read', path.virtual, VFSName.GITHUB, data.length, timer, { fingerprint: entry.id })
  return data
}

export async function* stream(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
