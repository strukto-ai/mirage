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

import { type PathSpec, type WalkEntry } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { type DeltaHook, ListingDeltaHook, synthDirs } from '@struktoai/mirage-core/watch/index'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { gridfsPrefix, iterLatest, prefixQuery, rawPathOf, stripKeyPrefix } from './client.ts'

/**
 * One flat `fs.files` aggregation feeding the generic differ.
 *
 * GridFS stores a flat filename space, so the whole subtree comes back from a
 * single prefix query rather than one round trip per directory, and the
 * aggregation already reduces each filename to its newest revision. Reads the
 * collection directly, never through mirage's caches, as the DeltaHook contract
 * requires.
 *
 * Fingerprints on the revision's ObjectId, which is exactly what `gridfs` stat
 * reports. That is an exact version: every upload mints a new document, so a
 * rewrite always moves it and an untouched file never does.
 */
class GridFSWalk {
  private readonly accessor: GridFSAccessor

  constructor(accessor: GridFSAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const config = this.accessor.config
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const pfx = gridfsPrefix(rawPathOf(root), config)
    const files: string[] = []
    const markers: string[] = []
    for await (const doc of iterLatest(this.accessor, prefixQuery(pfx))) {
      const relative = stripSlash(stripKeyPrefix(doc.filename, config))
      const virtual = prefix !== '' ? `${prefix}/${relative}` : `/${relative}`
      if (doc.filename.endsWith('/')) {
        // A directory marker, the same convention readdir reads as an
        // immediate child directory.
        markers.push(rstripSlash(virtual))
        continue
      }
      files.push(virtual)
      yield {
        virtual,
        isDir: false,
        fingerprint: doc._id.toString(),
        size: doc.length,
        modified: doc.uploadDate.toISOString(),
      }
    }
    yield* synthDirs(root.virtual, files, markers)
  }
}

export function buildDeltaHook(accessor: GridFSAccessor): DeltaHook {
  const walk = new GridFSWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
