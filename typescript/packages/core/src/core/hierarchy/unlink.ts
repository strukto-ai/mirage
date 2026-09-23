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

import type { Accessor } from '../../accessor/base.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { resolveEntry, type ReaddirFn } from './probe.ts'
import { INVALID, type DetectFn, type ScopeMatch } from './scope.ts'

export type DeleteFn<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  entry: IndexEntry,
) => Promise<void>

/**
 * Build a hierarchy unlink: classify, resolve, delete, invalidate.
 *
 * A deleter owns only the backend delete call; classification, the
 * id-resolving parent listing, the directory refusal and the cache
 * invalidation happen here, identically for every backend. `deleters` holds
 * one deleter per leaf kind. The match rides along because a delete
 * addressed inside a container needs the container's slots (gcal deletes an
 * event from a calendar), while a globally-id-addressed backend just
 * ignores it.
 */
export function makeUnlink<A extends Accessor>(
  detect: DetectFn,
  readdir: ReaddirFn<A>,
  options: { deleters: Readonly<Record<string, DeleteFn<A>>> },
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<void> {
  const { deleters } = options
  return async function unlink(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<void> {
    // Entry resolution reads what its parent-listing warm just wrote, so
    // a caller with no cache still needs one for the duration of the call.
    const store = index ?? new RAMIndexCacheStore()
    const match = detect(path)
    const deleter = deleters[match.kind]
    if (deleter === undefined) {
      if (match.kind !== INVALID && !match.scope?.leaf) {
        throw eisdir(path.virtual)
      }
      throw enoent(path.virtual)
    }
    const entry = await resolveEntry(readdir, accessor, path, store)
    if (entry === null) throw enoent(path.virtual)
    await deleter(accessor, match, entry)
    const prefix = mountPrefixOf(path.virtual, path.vfsPath)
    const key = stripSlash(path.vfsPath)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
    const parentDir = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    await store.invalidateDir(parentDir)
    await invalidateAfterUnlink(virtualKey)
  }
}
