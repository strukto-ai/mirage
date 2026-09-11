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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { resolvePath } from './path.ts'
import { ensureDirSizes } from './sizes.ts'
import { enoent } from '../../utils/errors.ts'
import { parent } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'

export async function stat(
  accessor: ChromaAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  if (resolved.isDir) {
    return new FileStat({
      name: statName(resolved.virtualKey, resolved.mountPrefix),
      type: FileType.DIRECTORY,
      extra: { children_count: 0 },
    })
  }
  if (resolved.entry === null) throw enoent(spec.virtual)
  let entry = resolved.entry
  if (entry.size === null) {
    // One scan for the whole directory, paid the first time anything in it
    // is stat'd; later stats of its siblings are already sized.
    await ensureDirSizes(accessor, parent(resolved.virtualKey), index)
    const refreshed = await index?.get(resolved.virtualKey)
    const sized = refreshed?.entry
    if (sized !== undefined && sized !== null) entry = sized
  }
  const updatedAt = entry.extra.updated_at
  return new FileStat({
    name: entry.name,
    type: FileType.FILE,
    content: ContentType.TEXT,
    size: entry.size,
    modified: typeof updatedAt === 'string' ? updatedAt : null,
    extra: { ...entry.extra },
  })
}

function statName(virtualKey: string, mountPrefix: string): string {
  const root = rstripSlash(mountPrefix) !== '' ? rstripSlash(mountPrefix) : '/'
  if (virtualKey === root) return '/'
  const stripped = rstripSlash(virtualKey)
  return stripped.split('/').pop() ?? '/'
}
