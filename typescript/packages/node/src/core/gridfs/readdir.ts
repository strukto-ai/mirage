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

import {
  IndexEntry,
  ResourceType,
  mountPrefixOf,
  rstripSlash,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { gridfsPrefix, iterLatest, prefixQuery, stripKeyPrefix } from './_client.ts'
import { SCOPE_ERROR } from './constants.ts'

export async function readdir(
  accessor: GridFSAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const original = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  // When called from resolveGlob with a pattern, use path.directory for the
  // listing; direct callers pass pattern=null so we use path.virtual.
  const virtual = path.pattern !== null ? path.directory : original
  const rawPath =
    prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual

  const virtualKey = rawPath === '/' ? '/' : rstripSlash(rawPath) || '/'
  const rawFullKey = prefix !== '' ? `${prefix}${virtualKey}` : virtualKey
  const fullVirtualKey = rstripSlash(rawFullKey) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(fullVirtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }

  const { config } = accessor
  const pfx = gridfsPrefix(rawPath, config)
  const names: string[] = []
  const dirKeys = new Set<string>()
  const sizes = new Map<string, number>()
  const times = new Map<string, string>()
  for await (const doc of iterLatest(accessor, prefixQuery(pfx))) {
    const fname = doc.filename
    if (fname === pfx) continue
    const relative = fname.slice(pfx.length)
    const slash = relative.indexOf('/')
    if (slash === -1) {
      const key = '/' + stripKeyPrefix(fname, config)
      names.push(key)
      sizes.set(key, doc.length)
      times.set(key, doc.uploadDate.toISOString())
    } else {
      // A deeper filename or a "seg/" directory marker both imply an
      // immediate child directory (S3 CommonPrefixes equivalent).
      const child = pfx + relative.slice(0, slash)
      const key = '/' + stripKeyPrefix(child, config)
      if (!dirKeys.has(key)) {
        names.push(key)
        dirKeys.add(key)
      }
    }
  }
  names.sort()
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `gridfs readdir: ${fullVirtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  const virtualEntries = names.map((e) => (prefix !== '' ? `${prefix}${e}` : e)).sort()
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = names.map((e) => {
      const name = e.split('/').pop() ?? ''
      if (dirKeys.has(e)) {
        // GridFS "folders" are synthetic prefixes with no file doc of
        // their own, so there is no uploadDate or length to record.
        return [name, new IndexEntry({ id: e, name, resourceType: ResourceType.FOLDER })]
      }
      return [
        name,
        new IndexEntry({
          id: e,
          name,
          resourceType: ResourceType.FILE,
          size: sizes.get(e) ?? null,
          remoteTime: times.get(e) ?? '',
        }),
      ]
    })
    await index.setDir(fullVirtualKey, indexEntries)
  }
  return virtualEntries
}
