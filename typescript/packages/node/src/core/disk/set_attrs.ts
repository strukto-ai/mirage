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
import { enoent, norm, type PathSpec } from '@struktoai/mirage-core'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { resolveSafe } from './utils.ts'

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

// Write metadata fields (the write side of stat). `mode` is applied to the
// real inode and recorded in the sidecar so stat output stays deterministic
// across host umasks; times go to the real inode; ownership is sidecar-only
// (chown to arbitrary ids needs privileges the process does not have).
// Stored, not enforced: mount mode does real access control, so the inode
// keeps owner access (`chmod 000` must not lock mirage itself out of reads,
// cp, or snapshot capture; the sidecar still reports the requested bits).
export async function setAttrs(
  accessor: DiskAccessor,
  path: PathSpec,
  fields: SetAttrsFields,
): Promise<void> {
  const full = resolveSafe(accessor.root, path.mountPath)
  let st
  try {
    st = await fsStat(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw enoent(path)
    throw err
  }
  const key = norm(path.mountPath)
  const entry = accessor.attrs.get(key) ?? {}
  if (fields.mode !== undefined) {
    const keep = st.isDirectory() ? 0o700 : 0o600
    await chmod(full, fields.mode | keep)
    entry.mode = fields.mode
  }
  if (fields.uid !== undefined) entry.uid = fields.uid
  if (fields.gid !== undefined) entry.gid = fields.gid
  if (fields.atime !== undefined) entry.atime = fields.atime
  accessor.attrs.set(key, entry)
  if (fields.atime !== undefined || fields.mtime !== undefined) {
    const newAtime = fields.atime !== undefined ? new Date(fields.atime) : st.atime
    const newMtime = fields.mtime !== undefined ? new Date(fields.mtime) : st.mtime
    await utimes(full, newAtime, newMtime)
  }
}
