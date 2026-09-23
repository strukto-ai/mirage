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

import type { PathSpec, WalkEntry } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  type DeltaHook,
  ListingDeltaHook,
  statFingerprint,
} from '@struktoai/mirage-core/watch/index'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { resolveSafe } from '../utils.ts'

async function* descend(root: string, full: string): AsyncGenerator<WalkEntry> {
  let listing
  try {
    listing = await readdir(full, { withFileTypes: true })
  } catch (error) {
    // Absence is the one error a walk may swallow: the directory went
    // away between the parent listing and this one, and the next pull
    // reports the DELETE from the snapshot diff. Anything else (EACCES,
    // EIO) means the subtree is unreadable, not empty, and returning
    // here would diff a partial listing into a DELETE for every child
    // plus a CREATE for each when access came back. Aborting the pull
    // keeps the prior checkpoint, which is what IncompleteWalkError
    // exists to protect.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  for (const entry of listing) {
    const child = path.join(full, entry.name)
    const virtual = '/' + path.relative(root, child).split(path.sep).join('/')
    if (entry.isDirectory()) {
      yield { virtual, isDir: true, fingerprint: null }
      yield* descend(root, child)
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await lstat(child)
    } catch (error) {
      // Same rule one entry down: a vanished file is a DELETE the next
      // pull reports, an unreadable one is not.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    const modified = info.mtime.toISOString()
    yield {
      virtual,
      isDir: false,
      fingerprint: statFingerprint(null, modified, info.size),
      size: info.size,
      modified,
    }
  }
}

/**
 * Recursive directory walk feeding the generic listing differ.
 *
 * Reads the filesystem directly, never through mirage's caches, as the
 * DeltaHook contract requires. Fingerprints on mtime, the same value `disk`
 * stat reports, so an editor that rewrites identical bytes still registers as
 * an UPDATE. That is the local filesystem's own resolution, not a mirage
 * choice: nothing cheaper than hashing every file can tell those two apart.
 *
 * Symlinks are not followed, matching every other disk walk in the repo and
 * keeping a link loop from hanging the poll.
 */
export class DiskWalk {
  private readonly accessor: DiskAccessor

  constructor(accessor: DiskAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const start = resolveSafe(this.accessor.root, root.mountPath)
    for await (const entry of descend(this.accessor.root, start)) {
      yield {
        ...entry,
        virtual: prefix !== '' ? `${prefix}${entry.virtual}` : entry.virtual,
      }
    }
  }
}

export function buildDeltaHook(accessor: DiskAccessor): DeltaHook {
  const walk = new DiskWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
