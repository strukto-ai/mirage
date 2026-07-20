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

import type { BoxAccessor } from '../../accessor/box.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName, readdir } from './readdir.ts'
import { stat } from './stat.ts'

export function find(
  accessor: BoxAccessor,
  path: PathSpec,
  options: FindOptions,
): Promise<string[]> {
  // Box readdir/stat resolve folder ids through an index cache. The generic
  // cp/find builders may call find without threading one (unlike Python,
  // whose cp threads the resource index), so walk with a scratch index that
  // this call populates as it descends.
  const idx = new RAMIndexCacheStore({ ttl: 86_400 })
  return walkFind(
    path,
    {
      readdir: (spec, i) => readdir(accessor, spec, i),
      stat: (spec, i) => stat(accessor, spec, i),
      isDirName: (child) => isDirName(child),
    },
    options,
    idx,
  )
}
