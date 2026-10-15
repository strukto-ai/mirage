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

import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'

/**
 * Whether anything exists at a path: the mount root, or a path its folder's
 * listing names. Mirrors Python's `exists`.
 */
export function exists(
  _accessor: HfHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<boolean> {
  return Promise.resolve(
    stripSlash(path.mountPath) === '' || (entry !== undefined && entry !== null),
  )
}
