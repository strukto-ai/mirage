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
import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { globToModifiedRange } from '../google/date_glob.ts'
import { GoogleFileSuffix, listAllFiles } from '../google/drive.ts'
import { makeFilename } from '../../resource/gdocs/doc_entry.ts'
import { stripSlash } from '../../utils/slash.ts'

const MIME = 'application/vnd.google-apps.document'

export function isDirName(child: string): boolean {
  // readdir emits only folders and rendered *.gdoc.json files.
  return !child.endsWith(GoogleFileSuffix.GDOC)
}

export async function readdir(
  accessor: GDocsAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const modifiedRange = path.pattern ? globToModifiedRange(path.pattern) : null
  const raw = path.pattern ? path.directory : path.virtual
  let p = raw
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

  if (key === '') {
    return [`${prefix}/owned`, `${prefix}/shared`]
  }

  if (key !== 'owned' && key !== 'shared') {
    const e = new Error(`ENOENT: ${path.virtual}`) as Error & { code: string }
    e.code = 'ENOENT'
    throw e
  }

  if (index !== undefined && modifiedRange === null) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }

  const files = await listAllFiles(accessor.tokenManager, {
    mimeType: MIME,
    modifiedAfter: modifiedRange ? modifiedRange[0] : null,
    modifiedBefore: modifiedRange ? modifiedRange[1] : null,
  })
  const isOwned = key === 'owned'
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const f of files) {
    const owners = f.owners ?? []
    const firstOwner = owners[0] ?? {}
    const fileOwned = firstOwner.me === true
    if (fileOwned !== isOwned) continue
    const filename = makeFilename(f.name, f.id, f.modifiedTime ?? '')
    const sizeRaw = f.size ?? f.quotaBytesUsed ?? '0'
    const sourceSize = Number.parseInt(sizeRaw, 10)
    // size stays null: Drive reports the source document's storage size, not
    // the rendered JSON length (FileStat.size must be render-derived or
    // null, see the CLAUDE.md FUSE rules). The source size lives in extra.
    const entry = new IndexEntry({
      id: f.id,
      name: f.name,
      resourceType: 'gdocs/file',
      remoteTime: f.modifiedTime ?? '',
      vfsName: filename,
      extra: Number.isFinite(sourceSize) && sourceSize > 0 ? { source_size: sourceSize } : {},
    })
    entries.push([filename, entry])
    names.push(`${prefix}/${key}/${filename}`)
  }

  if (index !== undefined) {
    if (modifiedRange !== null) {
      for (const [name, entry] of entries) {
        await index.put(`${virtualKey}/${name}`, entry)
      }
    } else {
      await index.setDir(virtualKey, entries)
    }
  }
  return names
}
