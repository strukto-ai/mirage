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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { read } from './read.ts'
import { ScopeLevel, detectScope } from './scope.ts'

const IMAGE_TYPES: Record<string, FileType> = {
  png: FileType.IMAGE_PNG,
  jpg: FileType.IMAGE_JPEG,
  jpeg: FileType.IMAGE_JPEG,
  gif: FileType.IMAGE_GIF,
}

function nameOf(spec: PathSpec): string {
  const stripped = rstripSlash(spec.virtual)
  const last = stripped.split('/').pop()
  return last === undefined || last === '' ? '/' : last
}

export async function stat(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)

  if (scope.level === ScopeLevel.UNKNOWN) throw enoent(spec.virtual)

  if (scope.table !== null) {
    if (!(await accessor.tableExists(scope.table))) throw enoent(spec.virtual)
  }

  if (scope.level === ScopeLevel.ROOT || scope.level === ScopeLevel.GROUP_DIR) {
    return new FileStat({ name: nameOf(spec), type: FileType.DIRECTORY })
  }

  const data = await read(accessor, spec, index)
  const fileType =
    scope.kind === 'blob' ? (IMAGE_TYPES[config.blobExt] ?? FileType.BINARY) : FileType.TEXT
  return new FileStat({ name: nameOf(spec), size: data.length, type: fileType })
}
