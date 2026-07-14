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
import type { BoxAccessor } from '../../accessor/box.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listFolderItems, type BoxItem } from './api.ts'
import { rstripSlash } from '../../utils/slash.ts'

const ROOT_FOLDER_ID = '0'

// File extensions that mirage post-processes into clean JSON. The vfs name
// gets a `.json` suffix appended so consumers (and the AI) see at a glance
// that cat returns JSON; the underlying Box file ID is the same regardless.
const SPECIAL_EXT_TO_RT: Readonly<Record<string, string>> = {
  '.boxnote': 'box/boxnote',
  '.boxcanvas': 'box/boxcanvas',
  '.gdoc': 'box/gdoc',
  '.gsheet': 'box/gsheet',
  '.gslides': 'box/gslides',
}

function specialResourceType(name: string): string | null {
  const lower = name.toLowerCase()
  for (const [src, rt] of Object.entries(SPECIAL_EXT_TO_RT)) {
    if (lower.endsWith(src)) return rt
  }
  return null
}

function vfsNameFor(name: string): string {
  const lower = name.toLowerCase()
  for (const src of Object.keys(SPECIAL_EXT_TO_RT)) {
    if (lower.endsWith(src)) return name + '.json'
  }
  return name
}

function resourceTypeFor(item: BoxItem): string {
  if (item.type === 'folder') return 'box/folder'
  if (item.type === 'web_link') return 'box/weblink'
  const specialRt = specialResourceType(item.name)
  if (specialRt !== null) return specialRt
  return 'box/file'
}

export async function readdir(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = (path.pattern !== null ? path.dir : path).resourcePath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }

  let folderId: string
  if (key === '') {
    folderId = ROOT_FOLDER_ID
  } else {
    if (index === undefined) {
      const e = new Error(`ENOENT: ${path.virtual}`) as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }
    let result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) {
      const parentOriginal = rstripSlash(path.virtual).replace(/\/[^/]+$/, '') || '/'
      if (parentOriginal !== path.virtual) {
        const parentPath = PathSpec.fromStrPath(parentOriginal, mountKey(parentOriginal, prefix))
        await readdir(accessor, parentPath, index)
        result = await index.get(virtualKey)
      }
      if (result.entry === undefined || result.entry === null) {
        const e = new Error(`ENOENT: ${path.virtual}`) as Error & { code: string }
        e.code = 'ENOENT'
        throw e
      }
    }
    folderId = result.entry.id
  }

  const items = await listFolderItems(accessor.tokenManager, folderId)
  const entries: { name: string; entry: IndexEntry; isDir: boolean }[] = []
  for (const it of items) {
    const isDir = it.type === 'folder'
    const filename = vfsNameFor(it.name)
    const sizeNum = typeof it.size === 'number' ? it.size : null
    const entry = new IndexEntry({
      id: it.id,
      name: filename,
      resourceType: resourceTypeFor(it),
      remoteTime: it.modified_at ?? '',
      vfsName: filename,
      size: !isDir && sizeNum !== null && sizeNum > 0 ? sizeNum : null,
    })
    entries.push({ name: filename, entry, isDir })
  }

  if (index !== undefined) {
    await index.setDir(
      virtualKey,
      entries.map((e) => [e.name, e.entry] as [string, IndexEntry]),
    )
  }
  const pathPrefix = key !== '' ? `/${key}/` : '/'
  const out: string[] = []
  for (const e of entries) {
    if (e.isDir) out.push(`${prefix}${pathPrefix}${e.name}/`)
    else out.push(`${prefix}${pathPrefix}${e.name}`)
  }
  return out
}
export function isDirName(child: string): boolean | null {
  // Cold reads mark folders with a trailing slash; warm index-cache hits
  // return slash-less keys, so fall back to stat for classification.
  return child.endsWith('/') ? true : null
}
