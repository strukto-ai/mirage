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
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { MIME_TO_EXT, listFiles, listSharedDrives } from '../google/drive.ts'
import { rstripSlash } from '../../utils/slash.ts'

export const DIRECTORY_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'gdrive/folder',
  'gdrive/shared_drive',
])

export function isDirName(child: string): boolean | null {
  // Cold listings mark folders with a trailing slash; warm index-cache
  // entries are slash-less, so classification falls back to stat.
  return child.endsWith('/') ? true : null
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DOC_MIME = 'application/vnd.google-apps.document'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const SLIDE_MIME = 'application/vnd.google-apps.presentation'

function resourceTypeFor(mime: string): string {
  if (mime === FOLDER_MIME) return 'gdrive/folder'
  if (mime === DOC_MIME) return 'gdrive/gdoc'
  if (mime === SHEET_MIME) return 'gdrive/gsheet'
  if (mime === SLIDE_MIME) return 'gdrive/gslide'
  return 'gdrive/file'
}

function uniqueSharedDriveName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name
  let filename = `${name} [Shared Drive]`
  let suffix = 2
  while (existingNames.has(filename)) {
    filename = `${name} [Shared Drive ${String(suffix)}]`
    suffix += 1
  }
  return filename
}

export async function readdir(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = (path.pattern !== null ? path.dir : path).resourcePath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    // Cached entries are slash-less, while the cold path below marks folders
    // with a trailing slash. Callers must not infer dir-ness from the slash
    // alone (see find's stat fallback).
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }

  let folderId: string
  let driveId: string | null = null
  if (key === '') {
    folderId = 'root'
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
    const entryDriveId = result.entry.extra.drive_id
    driveId = typeof entryDriveId === 'string' ? entryDriveId : null
  }

  const files = await listFiles(accessor.tokenManager, { folderId, driveId })
  const entries: { name: string; entry: IndexEntry; isDir: boolean }[] = []
  for (const f of files) {
    const mime = f.mimeType ?? ''
    const ext = MIME_TO_EXT[mime] ?? ''
    const filename = ext !== '' ? `${f.name}${ext}` : f.name
    const isDir = mime === FOLDER_MIME
    const sizeRaw = f.size ?? f.quotaBytesUsed ?? '0'
    const sizeNum = Number.parseInt(sizeRaw, 10)
    const entry = new IndexEntry({
      id: f.id,
      name: f.name,
      resourceType: resourceTypeFor(mime),
      remoteTime: f.modifiedTime ?? '',
      vfsName: filename,
      size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : null,
      extra: f.driveId !== undefined ? { drive_id: f.driveId } : {},
    })
    entries.push({ name: filename, entry, isDir })
  }

  if (key === '') {
    // Shared Drive enumeration is best-effort: if the account can't list
    // them (missing scope, API error), still return My Drive contents.
    let sharedDrives: { id: string; name: string }[] = []
    try {
      sharedDrives = await listSharedDrives(accessor.tokenManager)
    } catch {
      sharedDrives = []
    }
    const existingNames = new Set(entries.map((e) => e.name))
    for (const d of sharedDrives) {
      const filename = uniqueSharedDriveName(d.name, existingNames)
      existingNames.add(filename)
      const entry = new IndexEntry({
        id: d.id,
        name: d.name,
        resourceType: 'gdrive/shared_drive',
        vfsName: filename,
        extra: { drive_id: d.id },
      })
      entries.push({ name: filename, entry, isDir: true })
    }
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
