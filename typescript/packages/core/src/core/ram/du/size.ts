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

import type { RAMAccessor } from '../../../accessor/ram.ts'
import type { PathSpec } from '../../../types.ts'
import { norm } from '../utils.ts'
import { rstripSlash } from '../../../utils/slash.ts'

export function size(accessor: RAMAccessor, path: PathSpec): Promise<number> {
  const p = norm(path.mountPath)
  const prefix = rstripSlash(p) + '/'
  let total = 0
  for (const [key, data] of accessor.store.files) {
    if (key === p || key.startsWith(prefix)) total += data.byteLength
  }
  return Promise.resolve(total)
}
