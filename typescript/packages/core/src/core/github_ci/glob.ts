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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { resolveGlobWith } from '../../utils/glob_walk.ts'
import { SCOPE_ERROR } from '../github/constants.ts'
import { readdir } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'

export async function resolveGlob(
  accessor: GitHubCIAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[]> {
  return resolveGlobWith(readdir, accessor, paths, index, SCOPE_ERROR)
}

export function isCrossRunRoot(path: PathSpec): boolean {
  let original = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  if (prefix !== '' && original.startsWith(prefix)) {
    const rest = original.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) {
      original = rest === '' ? '/' : rest
    }
  }
  const stripped = stripSlash(original)
  return stripped === '' || stripped === 'runs'
}
