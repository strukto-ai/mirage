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
import { enoent, FileStat, FileType, guessType, norm, type PathSpec } from '@struktoai/mirage-core'
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
  const attrs = accessor.attrs.get(norm(virtual)) ?? {}
  if (st.isDirectory()) {
    return new FileStat({
      name,
      size: null,
      modified,
      type: FileType.DIRECTORY,
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
    })
  }
  return new FileStat({
    name,
    size: st.size,
    modified,
    fingerprint: modified,
    type: guessType(name),
    mode: attrs.mode ?? null,
    uid: attrs.uid ?? null,
    gid: attrs.gid ?? null,
    atime: attrs.atime ?? null,
  })
}
