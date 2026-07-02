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
import { norm } from './utils.ts'
import { rstripSlash } from '../../utils/slash.ts'

export function du(accessor: RAMAccessor, path: PathSpec): Promise<number> {
  const p = norm(path.mountPath)
  const prefix = rstripSlash(p) + '/'
  let total = 0
  for (const [key, data] of accessor.store.files) {
    if (key === p || key.startsWith(prefix)) total += data.byteLength
  }
  return Promise.resolve(total)
}

export function duAll(
  accessor: RAMAccessor,
  path: PathSpec,
): Promise<[entries: [string, number][], total: number]> {
  const p = norm(path.mountPath)
  const prefix = rstripSlash(p) + '/'
  const entries: [string, number][] = []
  let total = 0
  const sortedKeys = [...accessor.store.files.keys()].sort()
  for (const key of sortedKeys) {
    if (key === p || key.startsWith(prefix)) {
      const data = accessor.store.files.get(key)
      if (data === undefined) continue
      const size = data.byteLength
      entries.push([key, size])
      total += size
    }
  }
  return Promise.resolve([entries, total])
}
