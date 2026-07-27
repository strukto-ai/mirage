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

import { FileType, type PathSpec, stripSlash } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../../accessor/hf.ts'
import { isNotFound, rawPathOf } from '../util.ts'
import { statOrNull } from './walk.ts'

export async function size(accessor: HfAccessor, path: PathSpec): Promise<number> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return info.size ?? 0
  const target = rawPathOf(path)
  const pfx = stripSlash(target)
  const scanPath = pfx !== '' ? `${pfx}/` : '/'
  const op = await accessor.operator()
  let total = 0
  try {
    for (const entry of await op.list(scanPath, { recursive: true })) {
      if (entry.path().endsWith('/')) continue
      const length = entry.metadata().contentLength
      total += length !== null ? Number(length) : 0
    }
  } catch (err) {
    if (isNotFound(err)) return 0
    throw err
  }
  return total
}
