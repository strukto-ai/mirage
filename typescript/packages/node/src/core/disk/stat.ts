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

import type { BigIntStats } from 'node:fs'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { stat as fsStat } from 'node:fs/promises'
import path from 'node:path'
import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { diskError } from './errors.ts'
import { stamp, wallNs } from './listing_version.ts'
import { resolveInside } from './utils.ts'

/**
 * What `stat` answers for a host entry, from its host stat. `nowNs` is the
 * wall clock read before the stat; `versioned` is whether the mount stores
 * folder versions. Mirrors Python's `stat_of`.
 */
export function statOf(name: string, st: BigIntStats, nowNs: bigint, versioned: boolean): FileStat {
  const modified = st.mtime.toISOString()
  const mode = Number(st.mode & 0o7777n)
  const birthtime = st.birthtimeMs > 0n ? st.birthtime.toISOString() : null
  // Fields setattr applies natively (mode, times) read from the real
  // inode, so external chmod/utime stays visible. Ownership can never be
  // applied natively (chown needs privileges), so it lives wholly in the
  // namespace overlay, merged at the stat-merge layer; host uid/gid
  // numbers would also be machine-dependent noise.
  if (st.isDirectory()) {
    // A folder's fingerprint is the version its listing is stored at, so the
    // listing gate's check and the readdir fill agree.
    return new FileStat({
      name,
      size: null,
      modified,
      fingerprint: versioned ? stamp(st, nowNs) : null,
      type: FileType.DIRECTORY,
      mode,
      atime: st.atime.toISOString(),
      ctime: st.ctime.toISOString(),
      birthtime,
    })
  }
  return new FileStat({
    name,
    size: Number(st.size),
    modified,
    fingerprint: modified,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    mode,
    atime: st.atime.toISOString(),
    ctime: st.ctime.toISOString(),
    birthtime,
  })
}

export async function stat(accessor: DiskAccessor, p: PathSpec): Promise<FileStat> {
  const full = await resolveInside(accessor.root, p)
  const nowNs = wallNs()
  let st
  try {
    st = await fsStat(full, { bigint: true })
  } catch (err) {
    throw diskError(err, p)
  }
  return statOf(path.basename(full), st, nowNs, accessor.folderVersions)
}
