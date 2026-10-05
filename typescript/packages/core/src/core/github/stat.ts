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
import type { IndexEntry } from '../../cache/index/config.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { FileStat, FileType } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { GitHubApiError } from './client.ts'
import { fetchHead } from './tree.ts'
import { locate, lookupRetrying, pointLookup } from './lookup.ts'

// Render one tree row as a FileStat, the same from either route.
function statOf(entry: IndexEntry): FileStat {
  if (entry.resourceType === 'folder') {
    return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
  }
  return new FileStat({
    name: entry.name,
    size: entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(entry.name),
    fingerprint: entry.id,
    extra: { sha: entry.id },
  })
}

export async function stat(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const { prefix, rel, key } = locate(path)
  if (rel === '') {
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      fingerprint: await rootVersion(accessor, index),
    })
  }
  if (index === undefined) throw enoent(path)
  // A probe through a throwaway index asks for this one path; everything
  // else answers from the mount's listing, filling it if need be.
  const found =
    (await pointLookup(accessor, index, prefix, rel)) ??
    (await lookupRetrying(accessor, index, prefix, key))
  if (found.entry === null) throw enoent(path)
  return statOf(found.entry)
}

/**
 * The version of the whole mount: the head commit its ref is at.
 *
 * Only the gate's `ListingCheckStore` asks for it, with one shallow request.
 * Every other index (the mount's own, an undefined index) names no version
 * and reads nothing, neither the index nor the backend, so a getattr of the
 * root never pays a check or a store round trip: nothing reads a root
 * fingerprint off a mount-view stat. Nothing here refills the index: a
 * refused head names no version rather than falling into a lookup.
 *
 * Mirrors Python's `_root_version`.
 */
async function rootVersion(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
): Promise<string | null> {
  if (!(index instanceof ListingCheckStore)) return null
  try {
    return await fetchHead(accessor.transport, accessor.owner, accessor.repo, accessor.ref)
  } catch (err) {
    // An answer that refuses the head is no answer about the version, the
    // way pointRow reads a refusal; anything else propagates.
    if (!(err instanceof GitHubApiError)) throw err
    console.warn(`head of ${accessor.owner}/${accessor.repo} not answered: ${String(err)}`)
    return null
  }
}
