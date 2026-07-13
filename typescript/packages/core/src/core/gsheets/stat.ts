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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GSheetsAccessor } from '../../accessor/gsheets.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { enoent } from '../../utils/errors.ts'

const VIRTUAL_DIRS = new Set(['', 'owned', 'shared'])

export async function stat(
  accessor: GSheetsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath

  if (VIRTUAL_DIRS.has(key)) {
    const name = key !== '' ? key : '/'
    return new FileStat({ name, type: FileType.DIRECTORY })
  }

  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentVirtual = virtualKey.includes('/')
      ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
      : '/'
    try {
      await coreReaddir(
        accessor,
        new PathSpec({
          virtual: parentVirtual,
          directory: parentVirtual,
          resolved: false,
          resourcePath: mountKey(parentVirtual, prefix),
        }),
        index,
      )
    } catch {
      // parent listing failed — fall through
    }
    result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) {
      throw enoent(path.virtual)
    }
  }
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    type: FileType.JSON,
    modified: result.entry.remoteTime,
    size: result.entry.size,
    extra: { doc_id: result.entry.id, doc_name: result.entry.name, ...result.entry.extra },
  })
}
