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
import { listingError } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { keyOf, lookup, probeDir, probeFile } from './lookup.ts'

/**
 * List one directory of the repository.
 *
 * Answers in mount-absolute paths, the way the index keys them.
 */
export async function readdir(
  accessor: HfHubAccessor,
  pathSpec: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.vfsPath)
  const target = pathSpec.pattern === null ? pathSpec : pathSpec.dir
  const path = target.mountPath
  const found = await lookup(accessor, index, prefix, keyOf(prefix, path))
  if (found.children !== null) return found.children
  // A git tree implies every directory above a path it holds, so this store
  // cannot hold an orphan and the one-probe form is the right one; both probes
  // are map lookups against a listing already in memory, so the walk costs no
  // requests.
  throw await listingError(
    pathSpec,
    path,
    (p: string) => probeFile(accessor, index, prefix, p),
    (p: string) => probeDir(accessor, index, prefix, p),
  )
}
