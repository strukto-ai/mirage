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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { fsError } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { ListingDeltaHook } from '../../watch/delta.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { ReaddirWalk } from '../../watch/walk.ts'
import type { ReaddirFn } from '../hierarchy/probe.ts'

/**
 * The delta hook of a Google app mount: its own tree, walked. A pull lists
 * each corpus once, one Drive query narrowed to the app's MIME type, and
 * fingerprints a file by the modified time its stat reports. An edit on
 * another day renames the file, since the date leads the name, and reads as
 * one file gone and another made. A corpus Drive could not finish listing is
 * cached as entries but not as the directory, and fails the pull, so the files
 * it left out never read as deleted and the checkpoint stays where it was.
 * Mirrors Python's `app_delta_hook`.
 */
export function appDeltaHook<A extends GoogleApiAccessor>(
  accessor: A,
  readdir: ReaddirFn<A>,
  stat: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat>,
): DeltaHook {
  const walk = new ReaddirWalk(
    async (path: PathSpec, index: IndexCacheStore): Promise<string[]> => {
      const names = await readdir(accessor, path, index)
      const corpus = rstripSlash(path.virtual)
      const listing = await index.listDir(corpus)
      if (stripSlash(path.vfsPath) !== '' && (listing.entries ?? null) === null) {
        throw fsError(path, 'EIO')
      }
      return names
    },
    (path: PathSpec, index: IndexCacheStore): Promise<FileStat> => stat(accessor, path, index),
  )
  return new ListingDeltaHook(walk.walk.bind(walk))
}
