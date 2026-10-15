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
import { enoent } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { graphApi } from '../msgraph/config.ts'
import { GraphDeltaHook, type DeltaTarget } from '../msgraph/watch.ts'
import { driveEntries, resolve, siteEntries } from './resolve.ts'

/**
 * Build the SharePoint delta hook: the `/delta` feed of each document library
 * under the watch root (`GraphDeltaHook`).
 *
 * A mount scoped to one site and library reads that library's feed, placed
 * under its `keyPrefix`. An unscoped mount reads the library the root is in, or
 * each library of the site or tenant the root names, as the baseline finds
 * them. Mirrors Python `build_delta_hook`.
 */
export function buildDeltaHook(accessor: SharePointAccessor): DeltaHook {
  const config = accessor.config
  const drive = (driveId: string): string =>
    `${graphApi(config)}/drives/${encodeURIComponent(driveId)}`
  const targets = async (root: PathSpec): Promise<DeltaTarget[]> => {
    const prefix = rstripSlash(mountPrefixOf(root.virtual, root.vfsPath))
    const resolved = await resolve(accessor, root)
    if (config.site !== null && config.drive !== null) {
      if (resolved.driveId === null) throw enoent(root)
      return [
        {
          drive: drive(resolved.driveId),
          folder: config.keyPrefix,
          virtual: prefix === '' ? '/' : prefix,
        },
      ]
    }
    const parts = stripSlash(root.vfsPath).split('/')
    if (resolved.driveId !== null) {
      return [
        {
          drive: drive(resolved.driveId),
          folder: '',
          virtual: `${prefix}/${parts[0] ?? ''}/${parts[1] ?? ''}`,
        },
      ]
    }
    let sites: [string, string][]
    if (resolved.level === 'root') sites = await siteEntries(accessor)
    else if (resolved.level === 'site' && resolved.siteId !== null) {
      sites = [[parts[0] ?? '', resolved.siteId]]
    } else throw enoent(root)
    const found: DeltaTarget[] = []
    for (const [site, siteId] of sites) {
      for (const [name, driveId] of await driveEntries(accessor, siteId)) {
        found.push({ drive: drive(driveId), folder: '', virtual: `${prefix}/${site}/${name}` })
      }
    }
    return found
  }
  return new GraphDeltaHook(config, targets)
}
