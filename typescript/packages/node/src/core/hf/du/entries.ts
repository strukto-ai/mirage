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

import { compareCodePoints, FileType, type PathSpec, stripSlash } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../../accessor/hf.ts'
import { isNotFound, rawPathOf } from '../util.ts'
import { lstrip, statOrNull } from './walk.ts'

export async function entries(
  accessor: HfAccessor,
  path: PathSpec,
): Promise<[[string, number][], number]> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  const target = rawPathOf(path)
  const pfx = stripSlash(target)
  const scanPath = pfx !== '' ? `${pfx}/` : '/'
  const op = await accessor.operator()
  const results: [string, number][] = []
  let total = 0
  try {
    for (const entry of await op.list(scanPath, { recursive: true })) {
      const rel = entry.path()
      if (rel === '' || rel.endsWith('/')) continue
      const length = entry.metadata().contentLength
      const size = length !== null ? Number(length) : 0
      results.push([`/${lstrip(rel)}`, size])
      total += size
    }
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  results.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [results, total]
}
