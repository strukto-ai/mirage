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

import { FileStat } from '../../../types.ts'
import { epochToIso } from '../../../utils/dates.ts'
import type { NodeMeta } from './namespace.ts'

/**
 * Overlay namespace node attrs onto a backend stat.
 *
 * Backends without a native attribute slot store chmod/chown/touch
 * results in the namespace node table; every stat surface (dispatch,
 * the fs facade, FUSE) merges through here (overlay wins per-field)
 * so they cannot disagree.
 */
export function mergeOverlayStat(meta: NodeMeta | null, stat: FileStat): FileStat {
  if (meta === null) return stat
  const update: {
    mode?: number
    uid?: number | string
    gid?: number | string
    atime?: string
    modified?: string
  } = {}
  if (meta.mode !== undefined) update.mode = meta.mode
  if (meta.uid !== undefined) update.uid = meta.uid
  if (meta.gid !== undefined) update.gid = meta.gid
  if (meta.atime !== undefined) update.atime = meta.atime
  if (meta.mtime !== undefined && meta.target === undefined) {
    update.modified = epochToIso(meta.mtime)
  }
  if (Object.keys(update).length === 0) return stat
  return new FileStat({
    name: stat.name,
    size: stat.size,
    modified: update.modified ?? stat.modified,
    fingerprint: stat.fingerprint,
    revision: stat.revision,
    type: stat.type,
    mode: update.mode ?? stat.mode,
    uid: update.uid ?? stat.uid,
    gid: update.gid ?? stat.gid,
    atime: update.atime ?? stat.atime,
    extra: stat.extra,
  })
}
