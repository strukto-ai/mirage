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

import { chmod, stat as fsStat, utimes } from 'node:fs/promises'
import { enoent, type PathSpec } from '@struktoai/mirage-core'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { resolveSafe } from './utils.ts'

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

// Write metadata fields (the write side of stat). Applies natively what the
// real inode can take and returns the residual: fields the caller must
// overlay elsewhere. Times always apply. `mode` is applied with owner access
// kept (`chmod 000` must not lock mirage itself out of reads, cp, or
// snapshot capture; mount mode does real access control), so clamped bits
// come back as residual. Ownership never applies (chown to arbitrary ids
// needs privileges the process does not have) and is always residual.
export async function setAttrs(
  accessor: DiskAccessor,
  path: PathSpec,
  fields: SetAttrsFields,
): Promise<Record<string, number | string>> {
  const full = resolveSafe(accessor.root, path.mountPath)
  let st
  try {
    st = await fsStat(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw enoent(path)
    throw err
  }
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) {
    const keep = st.isDirectory() ? 0o700 : 0o600
    await chmod(full, fields.mode | keep)
    if ((fields.mode | keep) !== fields.mode) residual.mode = fields.mode
  }
  if (fields.uid !== undefined) residual.uid = fields.uid
  if (fields.gid !== undefined) residual.gid = fields.gid
  if (fields.atime !== undefined || fields.mtime !== undefined) {
    const newAtime = fields.atime !== undefined ? new Date(fields.atime) : st.atime
    const newMtime = fields.mtime !== undefined ? new Date(fields.mtime) : st.mtime
    await utimes(full, newAtime, newMtime)
  }
  return residual
}
