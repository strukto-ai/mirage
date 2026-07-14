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

import { enoent, type PathSpec } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from './utils.ts'

export interface SetAttrsFields {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
}

// Write metadata fields on an existing entry (the write side of stat).
// Fields live in a per-path attrs hash; values are stored as strings
// (redis hashes are string-valued) and decoded by stat. Stored, not
// enforced: mount mode does real access control.
export async function setAttrs(
  accessor: RedisAccessor,
  path: PathSpec,
  fields: SetAttrsFields,
): Promise<void> {
  const store = accessor.store
  const p = norm(path.mountPath)
  if (!(await store.hasFile(p)) && !(await store.hasDir(p))) {
    throw enoent(path)
  }
  const encoded: Record<string, string> = {}
  if (fields.mode !== undefined) encoded.mode = String(fields.mode)
  if (fields.uid !== undefined) encoded.uid = String(fields.uid)
  if (fields.gid !== undefined) encoded.gid = String(fields.gid)
  if (fields.atime !== undefined) encoded.atime = fields.atime
  if (Object.keys(encoded).length > 0) {
    await store.setAttrs(p, encoded)
  }
  if (fields.mtime !== undefined) {
    await store.setModified(p, fields.mtime)
  }
}
