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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { norm } from './utils.ts'

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

// Write metadata fields on an existing entry (the write side of stat).
// Only present fields are written. Stored, not enforced: mount mode does
// real access control.
export function setAttrs(
  accessor: RAMAccessor,
  path: PathSpec,
  fields: SetAttrsFields,
): Promise<void> {
  const store = accessor.store
  const p = norm(path.mountPath)
  if (!store.files.has(p) && !store.dirs.has(p)) {
    throw enoent(path)
  }
  const entry = store.attrs.get(p) ?? {}
  if (fields.mode !== undefined) entry.mode = fields.mode
  if (fields.uid !== undefined) entry.uid = fields.uid
  if (fields.gid !== undefined) entry.gid = fields.gid
  if (fields.atime !== undefined) entry.atime = fields.atime
  store.attrs.set(p, entry)
  if (fields.mtime !== undefined) store.modified.set(p, fields.mtime)
  return Promise.resolve()
}
