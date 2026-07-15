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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { stat as fsStat } from 'node:fs/promises'
import path from 'node:path'
import { enoent, FileStat, FileType, guessType, type PathSpec } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function stat(accessor: DiskAccessor, p: PathSpec): Promise<FileStat> {
  const virtual = p.mountPath
  const full = resolveSafe(accessor.root, virtual)
  let st
  try {
    st = await fsStat(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw enoent(p)
    }
    throw err
  }
  const modified = st.mtime.toISOString()
  const name = path.basename(full)
  // Fields setattr applies natively (mode, times) read from the real
  // inode, so external chmod/utime stays visible. Ownership can never be
  // applied natively (chown needs privileges), so it lives wholly in the
  // namespace overlay, merged at the stat-merge layer; host uid/gid
  // numbers would also be machine-dependent noise.
  if (st.isDirectory()) {
    return new FileStat({
      name,
      size: null,
      modified,
      type: FileType.DIRECTORY,
      mode: st.mode & 0o7777,
      atime: st.atime.toISOString(),
    })
  }
  return new FileStat({
    name,
    size: st.size,
    modified,
    fingerprint: modified,
    type: guessType(name),
    mode: st.mode & 0o7777,
    atime: st.atime.toISOString(),
  })
}
