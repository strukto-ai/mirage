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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { eacces, enoent, isEacces } from '../../errors/fs.ts'
import { revisionFor } from '../../observe/context.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import * as kp from '../../utils/key_prefix.ts'
import { rawPathOf } from '../../utils/key_prefix.ts'
import { gnuBasename } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { ObjectMeta, ObjectStoreDriver, StatFn } from './driver.ts'

/**
 * Whether any key sits under `pfx`; a refused probe is EACCES. A grant
 * without ListBucket refuses the probe as well as the key, so the refusal is
 * named for the path the caller reports. Mirrors Python's `proves_directory`.
 */
export async function provesDirectory<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  pfx: string,
  named: PathSpec,
): Promise<boolean> {
  try {
    return await driver.probePrefix(conn, pfx)
  } catch (err) {
    if (isEacces(err)) throw eacces(named)
    throw err
  }
}

/** Build the stat ladder over one driver: the object, then the prefix. */
export function makeStat<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): StatFn<A> {
  return async function stat(accessor, path) {
    const rawPath = rawPathOf(path)

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

    const kpfx = driver.keyPrefixOf(accessor)
    const key = kp.apply(kpfx, rawPath)
    let refused = false
    const { conn, close } = await driver.connect(accessor)
    try {
      // Point lookup first — works for files. Skipped when the path hints
      // a directory (trailing slash), so a coexisting object of the same
      // name does not shadow the prefix.
      if (!hintsDirectory) {
        const pinned = revisionFor(path.virtual)
        let meta: ObjectMeta | null
        try {
          meta =
            pinned !== null && driver.headRevision !== undefined
              ? await driver.headRevision(conn, key, pinned)
              : await driver.head(conn, key)
        } catch (err) {
          // A grant scoped below refuses a directory's own key.
          if (!isEacces(err)) throw err
          refused = true
          meta = null
        }
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
      if (await provesDirectory(driver, conn, pfx, path)) {
        return new FileStat({ name: gnuBasename(rawPath) || '/', type: FileType.DIRECTORY })
      }
    } finally {
      await close()
    }

    throw refused ? eacces(path) : enoent(path)
  }
}
