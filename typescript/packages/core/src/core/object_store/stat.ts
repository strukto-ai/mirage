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
import { ResourceType } from '../../cache/index/config.ts'
import { FileStat, FileType } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { gnuBasename } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { ObjectStoreDriver, StatFn } from './driver.ts'

/** Build the index-first stat ladder over one driver. */
export function makeStat<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): StatFn<A> {
  return async function stat(accessor, path, index) {
    const original = path.virtual
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    const rawPath =
      prefix !== '' && original.startsWith(prefix) ? original.slice(prefix.length) || '/' : original

    // A trailing slash signals the caller treats the path as a directory.
    // These stores allow an object at key "csv" AND deeper keys under
    // "csv/" to coexist; without this hint the file lookup would win and
    // `ls` on the slashed path would list the file itself instead of the
    // prefix.
    const hintsDirectory = rawPath.endsWith('/')

    const stripped = stripSlash(rawPath)
    if (stripped === '') {
      return new FileStat({ name: '/', type: FileType.DIRECTORY })
    }

    // Fast path: check the index cache populated by readdir(), which
    // stores entries with resource type "folder" or "file" and file
    // sizes, so stat can return instantly for known paths.
    if (index !== undefined) {
      const virtualKey = prefix !== '' ? `${prefix}/${stripped}` : '/' + stripped
      const lookup = await index.get(virtualKey)
      if (lookup.entry !== undefined && lookup.entry !== null) {
        const entry = lookup.entry
        // Store "folders" are synthetic prefixes with no object, so
        // readdir() records no time or size for them.
        if (entry.resourceType === ResourceType.FOLDER) {
          return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
        }
        return new FileStat({
          name: entry.name,
          size: entry.size ?? null,
          modified: entry.remoteTime !== '' ? entry.remoteTime : null,
          type: FileType.FILE,
          content: contentTypeForPath(entry.name),
        })
      }
      // If the parent directory was already listed by readdir() but this
      // path is not among its children, it does not exist. This avoids
      // expensive network calls for paths that shells probe speculatively
      // (e.g. .git, HEAD, .hg during cd).
      const parent = virtualKey.replace(/\/[^/]*$/, '') || '/'
      const parentListing = await index.listDir(parent)
      if (parentListing.entries !== undefined && parentListing.entries !== null) {
        throw enoent(path)
      }
    }

    // Slow path: no index cache available, or parent directory not yet
    // listed. Hit the store.
    const kpfx = driver.keyPrefixOf(accessor)
    const key = kp.apply(kpfx, rawPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      // Point lookup first — works for files. Skipped when the path hints
      // a directory (trailing slash), so a coexisting object of the same
      // name does not shadow the prefix.
      if (!hintsDirectory) {
        const meta = await driver.head(conn, key)
        if (meta !== null) {
          return new FileStat({
            name: gnuBasename(rawPath),
            size: meta.size,
            modified: meta.modified ?? null,
            fingerprint: meta.fingerprint ?? null,
            revision: meta.revision ?? null,
            type: FileType.FILE,
            content: contentTypeForPath(rawPath),
            extra: { ...(meta.extra ?? {}) },
          })
        }
      }

      // No object (or it was skipped) — check whether the path is a valid
      // prefix (directory): a marker or any deeper key proves it.
      const pfx = key !== '' ? rstripSlash(key) + '/' : ''
      if (await driver.probePrefix(conn, pfx)) {
        return new FileStat({ name: gnuBasename(rawPath) || '/', type: FileType.DIRECTORY })
      }
    } finally {
      await close()
    }

    throw enoent(path)
  }
}
