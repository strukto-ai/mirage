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
import type { LiveFileIdentity } from '../../ops/types.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { ObjectStoreDriver } from './driver.ts'

export type IdentityFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
) => Promise<LiveFileIdentity>

/**
 * Build the no-cache identity lookup over one driver.
 *
 * This is stat's slow path only: no index fast path, because the
 * guarantee is bypassing every cache, not serving the common case
 * fastest. A head miss earns exactly one more call, the prefix probe,
 * to tell "absent" from "directory".
 */
export function makeIdentity<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): IdentityFn<A> {
  return async function identity(accessor, path) {
    const original = path.virtual
    const prefix = mountPrefixOf(path.virtual, path.resourcePath)
    const rawPath =
      prefix !== '' && original.startsWith(prefix) ? original.slice(prefix.length) || '/' : original

    // A trailing slash signals the caller treats the path as a
    // directory, so the point lookup is skipped exactly as stat skips
    // it. A directory backed by a zero-byte marker object is keyed with
    // that slash, so heading it would answer the marker's own metadata
    // as a file identity for something the file-only contract has to
    // refuse. The probe decides instead: EISDIR when the directory is
    // there, absent when nothing is.
    const hintsDirectory = rawPath.endsWith('/')

    const stripped = stripSlash(rawPath)
    if (stripped === '') {
      throw eisdir(path)
    }

    const kpfx = driver.keyPrefixOf(accessor)
    const key = kp.apply(kpfx, rawPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      if (!hintsDirectory) {
        const meta = await driver.head(conn, key)
        if (meta !== null) {
          return {
            exists: true,
            revision: meta.revision ?? null,
            fingerprint: meta.fingerprint ?? null,
          }
        }
      }

      // Head missed (or was skipped): the one allowed second call tells
      // "absent" from "directory" (a marker or any deeper key proves
      // the prefix).
      const pfx = key !== '' ? rstripSlash(key) + '/' : ''
      if (await driver.probePrefix(conn, pfx)) {
        throw eisdir(path)
      }
    } finally {
      await close()
    }

    return { exists: false, revision: null, fingerprint: null }
  }
}
