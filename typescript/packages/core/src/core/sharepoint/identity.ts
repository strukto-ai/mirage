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

import type { SharePointAccessor } from '../../accessor/sharepoint.ts'
import type { LiveFileIdentity } from '../../ops/types.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { identityItem } from '../msgraph/drive.ts'

/**
 * Bounded identity lookup: resolve to a drive item, then one plain GET.
 *
 * The resolve is `fresh`: the site and drive name->id memos never
 * expire, so a drive deleted and recreated under the same name would
 * otherwise be addressed by an id that is gone, and the item GET
 * against it would answer 404 — reported as `exists: false` for a file
 * that is there. That costs the site and drive listings on every call
 * (two requests for an unscoped mount, none more), which is the price
 * of a live answer and is bounded by the namespace depth rather than by
 * the tree.
 *
 * A missing site or a missing drive is absence, not ENOENT: the
 * contract makes absence a value a caller branches on, and which
 * component of the path went missing is not something that caller
 * should have to handle two ways. EISDIR stays for a site or drive that
 * *does* resolve, because that path names a directory. Mirrors Python's
 * `live_identity`.
 */
export async function liveIdentity(
  accessor: SharePointAccessor,
  path: PathSpec,
): Promise<LiveFileIdentity> {
  if (path.resourcePath === '') throw eisdir(path)
  const resolved = await accessor.resolve(path.resourcePath, true)

  if (resolved.level === 'site') {
    if (resolved.siteId === null) return { exists: false, revision: null, fingerprint: null }
    throw eisdir(path)
  }
  if (resolved.level === 'drive') {
    if (resolved.driveId === null) return { exists: false, revision: null, fingerprint: null }
    throw eisdir(path)
  }
  if (resolved.driveId === null || resolved.itemPath === null) throw enoent(path)

  return identityItem(accessor.config, accessor.loc(resolved, path.resourcePath), path)
}
