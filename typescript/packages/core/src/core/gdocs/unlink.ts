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

import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { deleteFile } from '../google/drive.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { enoent } from '../../utils/errors.ts'

const VIRTUAL_DIRS = new Set(['', 'owned', 'shared'])

function eisdir(p: string): Error & { code: string } {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export async function unlink(
  accessor: GDocsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const prefix = path.prefix
  const key = path.key
  if (VIRTUAL_DIRS.has(key)) throw eisdir(path.original)
  if (index === undefined) throw enoent(path.original)
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
          original: parentVirtual,
          directory: parentVirtual,
          resolved: false,
          prefix,
        }),
        index,
      )
    } catch {
      // parent listing failed — fall through to not-found
    }
    result = await index.get(virtualKey)
  }
  if (result.entry === undefined || result.entry === null) throw enoent(path.original)
  await deleteFile(accessor.tokenManager, result.entry.id)
  const parentDir = virtualKey.includes('/')
    ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    : '/'
  await index.invalidateDir(parentDir)
  await invalidateAfterUnlink(virtualKey)
}
