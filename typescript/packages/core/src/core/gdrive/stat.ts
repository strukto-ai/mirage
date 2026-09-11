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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir as coreReaddir } from './readdir.ts'
import { enoent } from '../../utils/errors.ts'
import { FOLDER_MIME, MIME_TO_EXT, getFile } from '../google/drive.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { resolveKey } from './resolve.ts'

const MIME_TO_RT: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'gdrive/gdoc',
  'application/vnd.google-apps.spreadsheet': 'gdrive/gsheet',
  'application/vnd.google-apps.presentation': 'gdrive/gslide',
}

// Resolve a stat with direct Drive queries when the index can't answer.
// Generic write commands (cp/mv/rm) stat without an index, and gdrive is
// id-addressed, so a cold cache must not read as ENOENT.
async function statFromApi(
  accessor: GDriveAccessor,
  key: string,
  virtual: string,
): Promise<FileStat> {
  const node = await resolveKey(accessor, key)
  if (node === null) throw enoent(virtual)
  const item = await getFile(accessor.tokenManager, node.id)
  const modified = item.modifiedTime ?? ''
  if (node.mimeType === FOLDER_MIME) {
    return new FileStat({
      name: node.name,
      type: FileType.DIRECTORY,
      modified,
      extra: { file_id: node.id },
    })
  }
  const ext = MIME_TO_EXT[node.mimeType]
  const vfsName = ext !== undefined ? `${node.name}${ext}` : node.name
  // Native renders are size-unknown (see the CLAUDE.md FileStat.size rule).
  const size = ext !== undefined ? null : parseInt(item.size ?? '0', 10)
  return new FileStat({
    name: vfsName,
    size,
    type: FileType.FILE,
    content: contentTypeForPath(vfsName),
    modified,
    fingerprint: modified !== '' ? modified : null,
    extra: {
      file_id: node.id,
      resource_type: MIME_TO_RT[node.mimeType] ?? 'gdrive/file',
    },
  })
}

export async function stat(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  void accessor
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  if (index === undefined) return statFromApi(accessor, key, path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const parentVirtual = virtualKey.includes('/')
    ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    : '/'
  // A parent that cannot be listed at all leaves the API probe as the
  // authority; entryOrWarm decides which failures get that far.
  const entry = await entryOrWarm(index, virtualKey, () =>
    coreReaddir(
      accessor,
      new PathSpec({
        virtual: parentVirtual,
        directory: parentVirtual,
        resolved: false,
        resourcePath: mountKey(parentVirtual, prefix),
      }),
      index,
    ),
  )
  if (entry === null) return statFromApi(accessor, key, path.virtual)
  if (DIRECTORY_RESOURCE_TYPES.has(entry.resourceType)) {
    return new FileStat({
      name: entry.vfsName !== '' ? entry.vfsName : entry.name,
      type: FileType.DIRECTORY,
      modified: entry.remoteTime,
      extra: { file_id: entry.id },
    })
  }
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    size: entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(entry.vfsName),
    modified: entry.remoteTime,
    fingerprint: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: {
      file_id: entry.id,
      resource_type: entry.resourceType,
    },
  })
}
