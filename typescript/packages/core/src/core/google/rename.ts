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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { invalidateAfterMove } from '../../cache/context.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { eisdir, enoent, fsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { resolveEntry, type ReaddirFn } from '../hierarchy/probe.ts'
import { INVALID, type DetectFn } from '../hierarchy/scope.ts'
import { getFile, patchFile } from './drive.ts'
import { DATE_LEN, appFilename } from './scope.ts'

/**
 * The title a file name gives a file, null when the listing would render
 * that title under any other name. Mirrors Python's `app_title`.
 */
export function appTitle(
  name: string,
  fileId: string,
  modified: string,
  suffix: string,
): string | null {
  const lead = modified.length >= DATE_LEN ? `${modified.slice(0, DATE_LEN)}_` : ''
  const tail = `__${fileId}${suffix}`
  if (!name.startsWith(lead) || !name.endsWith(tail)) return null
  const title = name.slice(lead.length, name.length - tail.length)
  return appFilename(title, fileId, modified, suffix) === name ? title : null
}

/**
 * The rename of a Google app mount: a new title for a file. A file can take
 * only a name the listing renders back (same folder, date and id); its
 * modified time goes back unchanged, as rename(2) leaves it, and any other
 * name is EPERM. Mirrors Python's `make_app_rename`.
 */
export function makeAppRename<A extends GoogleApiAccessor>(
  detect: DetectFn,
  readdir: ReaddirFn<A>,
  suffix: string,
): (accessor: A, src: PathSpec, dst: PathSpec, index?: IndexCacheStore) => Promise<void> {
  return async function rename(
    accessor: A,
    src: PathSpec,
    dst: PathSpec,
    index?: IndexCacheStore,
  ): Promise<void> {
    const store = index ?? new RAMIndexCacheStore()
    const match = detect(src)
    if (match.kind !== 'file') {
      if (match.kind !== INVALID && !match.scope?.leaf) throw eisdir(src.virtual)
      throw enoent(src.virtual)
    }
    const entry = await resolveEntry(readdir, accessor, src, store)
    if (entry === null) throw enoent(src.virtual)
    const tm = accessor.tokenManager
    const modified = (await getFile(tm, entry.id)).modifiedTime ?? ''
    const cut = dst.virtual.lastIndexOf('/')
    const title = appTitle(dst.virtual.slice(cut + 1), entry.id, modified, suffix)
    if (
      title === null ||
      dst.virtual.slice(0, cut) !== src.virtual.slice(0, src.virtual.lastIndexOf('/'))
    ) {
      throw fsError(dst, 'EPERM')
    }
    await patchFile(tm, entry.id, { body: { name: title, modifiedTime: modified } })
    const prefix = mountPrefixOf(src.virtual, src.vfsPath)
    const key = stripSlash(src.vfsPath)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
    await store.invalidateDir(virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/')
    await invalidateAfterMove(dst, false)
    await invalidateAfterMove(src, false)
  }
}
