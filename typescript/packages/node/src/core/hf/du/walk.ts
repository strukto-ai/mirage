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

import { type FileStat, type PathSpec } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../../accessor/hf.ts'
import { stat } from '../stat.ts'

export async function statOrNull(accessor: HfAccessor, path: PathSpec): Promise<FileStat | null> {
  try {
    return await stat(accessor, path)
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return null
    throw err
  }
}

export function lstrip(value: string): string {
  let start = 0
  while (start < value.length && value[start] === '/') start += 1
  return value.slice(start)
}
