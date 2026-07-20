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

import type { DifyAccessor } from '../../accessor/dify.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { resolvePath } from './path.ts'

export async function readdir(
  accessor: DifyAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  if (!resolved.isDir) throw enotdir(spec.virtual)
  if (index === undefined) throw new Error('dify: missing index')
  const listing = await index.listDir(resolved.virtualKey)
  if (listing.entries === undefined || listing.entries === null) {
    throw enoent(spec.virtual)
  }
  return listing.entries
}
