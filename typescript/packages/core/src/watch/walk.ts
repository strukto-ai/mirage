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

import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import {
  FileType,
  PathSpec,
  type FileStat,
  type ReaddirFn,
  type StatFn,
  type WalkEntry,
} from '../types.ts'
import { isEnoent } from '../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import { statFingerprint } from './fingerprint.ts'

// The walk always supplies its own index, so both are the two-argument
// spellings of the shared aliases rather than new types.
export type WalkReaddirFn = ReaddirFn<[path: PathSpec, index: IndexCacheStore]>
export type WalkStatFn = StatFn<[path: PathSpec, index: IndexCacheStore]>

function* ancestors(stem: string, start: string, seen: Set<string>): Generator<WalkEntry> {
  let parent = start
  while (parent !== '' && parent !== stem && !seen.has(parent)) {
    seen.add(parent)
    yield { virtual: parent, isDir: true, fingerprint: null }
    parent = parent.slice(0, Math.max(parent.lastIndexOf('/'), 0))
  }
}

/**
 * Directory rows a prefix store implies but does not store.
 *
 * An object store has no directories: `ls` shows them because readdir
 * synthesizes them from the common prefixes of the keys, and a walk feeding
 * change detection has to synthesize the same ones, or a consumer would see a
 * file appear inside a directory that never appeared.
 *
 * `dirs` carries prefixes the store does name explicitly (a zero-byte marker
 * key, which mirage's own `mkdir` writes), so an empty directory is still
 * reported. A prefix backed by both a marker and children is reported once.
 *
 * `root` itself is never emitted; find's start-point rule applies here too,
 * the generic owns that row.
 */
export function* synthDirs(
  root: string,
  files: Iterable<string>,
  dirs: Iterable<string>,
): Generator<WalkEntry> {
  const stem = rstripSlash(root)
  const seen = new Set<string>()
  for (const path of dirs) yield* ancestors(stem, rstripSlash(path), seen)
  for (const path of files) {
    yield* ancestors(stem, path.slice(0, Math.max(path.lastIndexOf('/'), 0)), seen)
  }
}

/** One walk row built from a backend's own stat. */
export function entryOf(virtual: string, stat: FileStat): WalkEntry {
  if (stat.type === FileType.DIRECTORY) return { virtual, isDir: true, fingerprint: null }
  const size = stat.size ?? null
  const modified = stat.modified ?? null
  return {
    virtual,
    isDir: false,
    fingerprint: statFingerprint(stat.fingerprint ?? null, modified, size),
    size,
    modified,
  }
}

function specAt(virtual: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resolved: false,
    vfsPath: mountKey(virtual, prefix),
  })
}

async function statAt(
  stat: WalkStatFn,
  virtual: string,
  prefix: string,
  index: IndexCacheStore,
): Promise<FileStat | null> {
  try {
    return await stat(specAt(virtual, prefix), index)
  } catch (error) {
    // Removed between the readdir and the stat; the next pull reports
    // the DELETE from the snapshot diff. Only absence is swallowed, an
    // API error still propagates.
    if (isEnoent(error)) return null
    throw error
  }
}

async function* descend(
  readdir: WalkReaddirFn,
  stat: WalkStatFn,
  spec: PathSpec,
  index: IndexCacheStore,
  prefix: string,
): AsyncGenerator<WalkEntry> {
  let children: string[]
  try {
    children = await readdir(spec, index)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  for (const child of children) {
    // Classification is stat's job, the same rule find's walk follows:
    // the one in-band proof is a trailing slash on a cold listing, and
    // the stat behind it is an index lookup against the readdir that
    // just populated it, not another request.
    const trimmed = rstripSlash(child)
    let isDir: boolean
    if (child.endsWith('/')) {
      yield { virtual: trimmed, isDir: true, fingerprint: null }
      isDir = true
    } else {
      const found = await statAt(stat, trimmed, prefix, index)
      if (found === null) continue
      yield entryOf(trimmed, found)
      isDir = found.type === FileType.DIRECTORY
    }
    if (isDir) yield* descend(readdir, stat, specAt(trimmed, prefix), index, prefix)
  }
}

/**
 * Recursive readdir descent for a backend with no recursive listing.
 *
 * Box, Google Drive and Microsoft Graph key their trees by opaque id, so a
 * child cannot be addressed without having listed its parent, and none of them
 * offers a whole-subtree listing. This walks them the way `find` does, one
 * readdir per directory.
 *
 * Each pull builds its own index and throws it away afterwards. That is what
 * keeps the DeltaHook contract: the index is not mirage's read cache, so the
 * walk cannot compare the cache to itself, and it starts empty every time, so
 * nothing carries over between pulls. It still has to exist, because these
 * backends resolve a path's id through the index their parent's readdir
 * populated; handing them a null index makes every path below the root read as
 * absent.
 */
export class ReaddirWalk {
  private readonly readdir: WalkReaddirFn
  private readonly stat: WalkStatFn

  constructor(readdir: WalkReaddirFn, stat: WalkStatFn) {
    this.readdir = readdir
    this.stat = stat
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    yield* descend(this.readdir, this.stat, root, new RAMIndexCacheStore(), prefix)
  }
}
