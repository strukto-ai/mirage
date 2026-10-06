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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { isEnoent } from '@struktoai/mirage-core/errors/fs'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { stat } from './stat.ts'

/** Whether anything exists at a path: a file or a directory. */
export async function exists(
  accessor: HfHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  try {
    await stat(accessor, path, index)
  } catch (err) {
    // "Cannot see the repo" is not "the path is absent"; only the latter
    // answers false, as python's twin catches FileNotFoundError alone.
    if (isEnoent(err)) return false
    throw err
  }
  return true
}
