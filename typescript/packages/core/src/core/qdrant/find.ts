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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import { walkFind } from '../generic/find.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

function isRowFile(name: string, config: QdrantAccessor['config']): boolean {
  if (name.endsWith('.json')) return true
  if (config.textField !== null && name.endsWith('.txt')) return true
  if (config.blobField !== null && name.endsWith(`.${config.blobExt}`)) return true
  return false
}

export async function find(
  accessor: QdrantAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec) => readdir(accessor, spec),
      stat: (spec, idx) => stat(accessor, spec, idx),
      // Row files are recognized by extension, so classification never
      // needs the stat fallback.
      isDirName: (child) => !isRowFile(child.split('/').pop() ?? '', accessor.config),
    },
    options,
  )
}
